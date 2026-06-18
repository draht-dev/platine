// SPDX-License-Identifier: Apache-2.0
/**
 * runs.test.ts — tests for the `platine runs` command.
 *
 * Uses injected MemoryStorage + LocalRuntime — no network, no DynamoDB.
 */

import { describe, it, expect } from "vitest";
import { runsList, runsGet, runsApprove, runsResume } from "./runs.js";
import {
  MemoryStorage,
  createLocalRuntime,
  FakeToolsDispatcher,
} from "@draht/runtime-aws";
import type { Model, ModelRequest, ModelStreamEvent, Usage, RunRecord, TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";

// Minimal inline ScriptedModel (ScriptedModel is only in runtime-aws/src/fake-model.ts,
// not a stable sub-path export).
type FakeModelResponse =
  | { stopReason: "end_turn"; text: string }
  | { stopReason: "tool_use"; text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> };

class ScriptedModel implements Model {
  private readonly script: FakeModelResponse[];
  private readonly _usage: Usage;

  constructor(script: FakeModelResponse[], usage: Usage = { inputTokens: 10, outputTokens: 5 }) {
    this.script = [...script];
    this._usage = usage;
  }

  async chat(req: ModelRequest): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    void req;
    const next = this.script.shift() ?? { stopReason: "end_turn" as const, text: "done" };
    return {
      type: "done",
      stopReason: next.stopReason,
      text: next.text,
      toolCalls: "toolCalls" in next ? next.toolCalls : [],
      usage: { ...this._usage },
      modelId: req.modelId,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await this.chat(req);
  }

  supports(_modelId: string): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extend MemoryStorage with a listRuns() method for the CLI runs list command. */
class TestMemoryStorage extends MemoryStorage {
  /** List all runs for a tenant. */
  async listRuns(_tenantId: TenantId): Promise<RunRecord[]> {
    // Access internal state via getRun: we enumerate known run IDs.
    // In tests, we inject runs directly via ensureRun.
    // MemoryStorage exposes runs via getRun; we need a way to list them.
    // We'll track inserted run IDs in this subclass.
    const records: RunRecord[] = [];
    for (const id of this._runIds) {
      const r = await this.getRun(_tenantId, id as RunId);
      if (r) records.push(r);
    }
    return records;
  }

  readonly _runIds: Set<string> = new Set();

  override async ensureRun(r: {
    tenantId: TenantId;
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
  }): Promise<RunRecord> {
    this._runIds.add(r.runId);
    return super.ensureRun(r);
  }
}

function makeRunRecord(partial: Partial<RunRecord> = {}): RunRecord {
  return {
    tenantId: DEFAULT_TENANT,
    runId: ("run_" + Math.random().toString(36).slice(2)) as RunId,
    manifestId: "test-agent",
    manifestRevision: "rev_test",
    status: "completed",
    chainDepth: 0,
    attempt: 1,
    continuations: 0,
    steps: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runs list", () => {
  it("returns an empty list when no runs exist", async () => {
    const storage = new TestMemoryStorage();

    const { runs } = await runsList({ storage });

    expect(runs).toEqual([]);
  });

  it("returns inserted runs", async () => {
    const storage = new TestMemoryStorage();

    const r1 = makeRunRecord({ status: "completed" });
    const r2 = makeRunRecord({ status: "failed" });

    await storage.ensureRun({ tenantId: r1.tenantId, runId: r1.runId, manifestId: r1.manifestId, manifestRevision: r1.manifestRevision });
    await storage.setRunStatus(r1.tenantId, r1.runId, "completed", {});
    await storage.ensureRun({ tenantId: r2.tenantId, runId: r2.runId, manifestId: r2.manifestId, manifestRevision: r2.manifestRevision });
    await storage.setRunStatus(r2.tenantId, r2.runId, "failed", { error: "err" });

    const { runs } = await runsList({ storage });

    expect(runs).toHaveLength(2);
    const statuses = runs.map((r) => r.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("failed");
  });

  it("filters by status", async () => {
    const storage = new TestMemoryStorage();

    const r1 = makeRunRecord({ status: "completed" });
    const r2 = makeRunRecord({ status: "failed" });

    await storage.ensureRun({ tenantId: r1.tenantId, runId: r1.runId, manifestId: r1.manifestId, manifestRevision: r1.manifestRevision });
    await storage.setRunStatus(r1.tenantId, r1.runId, "completed", {});
    await storage.ensureRun({ tenantId: r2.tenantId, runId: r2.runId, manifestId: r2.manifestId, manifestRevision: r2.manifestRevision });
    await storage.setRunStatus(r2.tenantId, r2.runId, "failed", { error: "err" });

    const { runs } = await runsList({ storage, status: "completed" });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
  });

  it("respects the limit option", async () => {
    const storage = new TestMemoryStorage();

    for (let i = 0; i < 5; i++) {
      const r = makeRunRecord();
      await storage.ensureRun({ tenantId: r.tenantId, runId: r.runId, manifestId: r.manifestId, manifestRevision: r.manifestRevision });
    }

    const { runs } = await runsList({ storage, limit: 3 });

    expect(runs).toHaveLength(3);
  });

  it("throws without --table when no storage injected and not local", async () => {
    await expect(runsList({})).rejects.toThrow(/table/i);
  });
});

describe("runs get", () => {
  it("returns null for an unknown run ID", async () => {
    const storage = new TestMemoryStorage();

    const { run } = await runsGet({
      storage,
      runId: "run_doesnotexist" as RunId,
    });

    expect(run).toBeNull();
  });

  it("returns the run record for a known ID", async () => {
    const storage = new TestMemoryStorage();
    const r = makeRunRecord({ status: "completed" });

    await storage.ensureRun({ tenantId: r.tenantId, runId: r.runId, manifestId: r.manifestId, manifestRevision: r.manifestRevision });
    await storage.setRunStatus(r.tenantId, r.runId, "completed", {});

    const { run } = await runsGet({ storage, runId: r.runId });

    expect(run).not.toBeNull();
    expect(run?.runId).toBe(r.runId);
    expect(run?.status).toBe("completed");
  });
});

describe("runs approve", () => {
  it("resolves a pending approval and returns updated status", async () => {
    const model = new ScriptedModel([{ stopReason: "end_turn", text: "done" }]);
    const tools = new FakeToolsDispatcher();

    const { runtime, storage, queue } = createLocalRuntime({ model, tools });

    // Create a run with an approval-gated tool node
    const manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_approval_test",
      kind: "workflow",
      agent: {
        agentId: "approval-agent",
        name: "Approval Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:app", inline: "Approval test" },
        skills: [],
        maxIterations: 5,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [
        {
          toolId: "tool_gate",
          name: "gate_tool",
          description: "Approval-gated",
          kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: true,
          dangerous: false,
        },
      ],
      nodes: [
        {
          nodeId: "gate_1",
          kind: "tool",
          toolRef: "tool_gate",
          requiresApproval: true,
          params: {},
          outputSchema: [],
        },
      ],
      edges: [],
      resources: {
        needsHttpEgress: false,
        needsBedrock: false,
        needsEventBus: true,
        secrets: [],
        extraIam: [],
      },
      resume: { via: "api", holdsApproval: true },
    };

    const manifestStr = JSON.stringify(manifest);
    await storage.putManifest("approval-agent", "rev_approval_test", manifestStr);

    // Use submitRun so the queue gets populated
    const runId = "run_approval_test" as RunId;
    await runtime.submitRun({
      runId,
      manifestId: "approval-agent",
      manifestRevision: "rev_approval_test",
      tenantId: DEFAULT_TENANT,
      trigger: { type: "manual", payload: {} },
      input: {},
      chainDepth: 0,
    });

    // Drain the queue to reach awaiting_approval
    await runtime.drainQueue({ deadlineAt: Date.now() + 10_000 });

    const runBefore = await storage.getRun(DEFAULT_TENANT, runId);
    expect(runBefore?.status).toBe("awaiting_approval");

    // Get the pending approval action ID
    const approvals = storage.getApprovals();
    const pendingApproval = [...approvals.values()].find((a) => a.runId === runId);
    expect(pendingApproval).toBeDefined();

    const actionId = pendingApproval!.actionId;

    // Register the tool so it can execute after approval
    tools.register("tool_gate", async () => ({ done: true }));

    // Call runsApprove with the injected runtime
    const { status } = await runsApprove({
      runtime,
      storage,
      runId,
      actionId,
      decision: "approved",
    });

    // Status should have been updated (either running or queued, then drain completes it)
    expect(["running", "queued", "completed"]).toContain(status);

    // Drain the queue to complete the run
    await runtime.drainQueue({ deadlineAt: Date.now() + 10_000 });

    const runAfter = await storage.getRun(DEFAULT_TENANT, runId);
    expect(runAfter?.status).toBe("completed");

    void queue; // used for side effects
  });
});

describe("runs resume", () => {
  it("resumes a paused run via injected runtime", async () => {
    const model = new ScriptedModel([]);
    const tools = new FakeToolsDispatcher();
    const { runtime, storage } = createLocalRuntime({ model, tools });

    const runId = "run_resume_test" as RunId;
    await storage.ensureRun({
      tenantId: DEFAULT_TENANT,
      runId,
      manifestId: "test-agent",
      manifestRevision: "rev_test",
    });
    await storage.setRunStatus(DEFAULT_TENANT, runId, "paused", {});

    // Inject a simple manifest
    const manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_test",
      kind: "workflow",
      agent: {
        agentId: "test-agent",
        name: "Test Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:000", inline: "Test" },
        skills: [],
        maxIterations: 5,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [],
      nodes: [],
      edges: [],
      resources: {
        needsHttpEgress: false,
        needsBedrock: false,
        needsEventBus: true,
        secrets: [],
        extraIam: [],
      },
      resume: { via: "api", holdsApproval: false },
    };
    await storage.putManifest("test-agent", "rev_test", JSON.stringify(manifest));

    const { status } = await runsResume({ runtime, runId });

    // Should have resumed (queued or running or completed since no nodes)
    expect(["queued", "running", "completed"]).toContain(status);
  });
});
