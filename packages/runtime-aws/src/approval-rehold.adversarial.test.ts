// SPDX-License-Identifier: Apache-2.0
/**
 * approval-rehold.adversarial.test.ts — verifies the approval re-hold fix.
 *
 * HOLE #1 FIX: After a GRANTED approval + resume, drive() must NOT re-hold the
 * same node. The fix is: before the hold branch in runStep, check
 * storage.getApprovalByStep(runId, nodeId); if status === "approved", skip the
 * hold and fall through to dispatch the tool.
 */
import { describe, it, expect } from "vitest";
import type { RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { Manifest } from "@draht/core/manifest";
import { createLocalRuntime } from "./runtime-local.js";
import { ScriptedModel } from "./fake-model.js";

const TENANT = DEFAULT_TENANT;

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: "1.0.0", revision: "rev_adv", kind: "workflow",
    agent: { agentId: "adv-agent", name: "Adv", model: { provider: "anthropic", modelId: "claude-haiku-4-5" }, instructionsRef: { contentHash: "sha256:abc", inline: "t" }, skills: [], maxIterations: 3, maxToolCallsPerIteration: 3, circuitBreakerErrorThreshold: 5 },
    tenancy: { mode: "single" }, triggers: [{ type: "manual" }], channels: [], connections: [], tools: [], nodes: [], edges: [],
    resources: { needsHttpEgress: false, needsBedrock: false, needsEventBus: true, secrets: [], extraIam: [] },
    resume: { via: "api", holdsApproval: false }, ...overrides,
  };
}

describe("approval re-hold fix (regression guard)", () => {
  it("after approved + resume, the node runs exactly once and the run completes", async () => {
    const { runtime, storage, tools } = createLocalRuntime({ model: new ScriptedModel([]) });
    tools.register("danger", async () => ({ executed: true }));
    const manifest = makeManifest({
      tools: [{ toolId: "danger", name: "danger", description: "d", kind: "local", inputSchema: { type: "object", properties: {}, required: [] }, requiresApproval: true, dangerous: true }],
      nodes: [{ nodeId: "g", kind: "tool", toolRef: "danger", requiresApproval: true, params: {}, outputSchema: [] }],
      edges: [], resume: { via: "api", holdsApproval: true },
    });
    await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    const runId = "rehold" as RunId;
    await runtime.submitRun({ runId, manifestId: manifest.agent.agentId, manifestRevision: manifest.revision, tenantId: TENANT, trigger: { type: "manual" }, input: {}, chainDepth: 0 });
    await runtime.drainQueue();

    // Initial drive: must hold
    expect((await runtime.getRun(runId))?.status).toBe("awaiting_approval");
    expect(tools.getCallCount("danger")).toBe(0);
    const firstApprovalCount = storage.getApprovals().size;
    expect(firstApprovalCount).toBe(1);

    // Approve via public seam.
    const row1 = [...storage.getApprovals().values()][0]!;
    await runtime.resumeRun({ kind: "approval", runId, approvalId: row1.actionId, decision: "approved", by: "tester" });
    await runtime.drainQueue();

    const status = (await runtime.getRun(runId))?.status;
    const fires = tools.getCallCount("danger");

    // FIX: approval was granted — gate clears, tool runs exactly once, run completes.
    expect(fires).toBe(1);
    expect(status).toBe("completed");
    // approval row count unchanged (createPendingApproval dedupes on runId+stepId)
    expect(storage.getApprovals().size).toBe(1);
  });

  it("N consecutive approve+resume cycles: tool runs on the first, run completes, further resumes are no-ops", async () => {
    const { runtime, storage, tools } = createLocalRuntime({ model: new ScriptedModel([]) });
    tools.register("danger", async () => ({ executed: true }));
    const manifest = makeManifest({
      tools: [{ toolId: "danger", name: "danger", description: "d", kind: "local", inputSchema: { type: "object", properties: {}, required: [] }, requiresApproval: true, dangerous: true }],
      nodes: [{ nodeId: "g", kind: "tool", toolRef: "danger", requiresApproval: true, params: {}, outputSchema: [] }],
      edges: [], resume: { via: "api", holdsApproval: true },
    });
    await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    const runId = "rehold2" as RunId;
    await runtime.submitRun({ runId, manifestId: manifest.agent.agentId, manifestRevision: manifest.revision, tenantId: TENANT, trigger: { type: "manual" }, input: {}, chainDepth: 0 });
    await runtime.drainQueue();

    // First approval cycle clears the gate and completes the run.
    const row = [...storage.getApprovals().values()][0]!;
    await runtime.resumeRun({ kind: "approval", runId, approvalId: row.actionId, decision: "approved" }).catch(() => {});
    await runtime.drainQueue();

    // Tool fired exactly once; run is done.
    expect(tools.getCallCount("danger")).toBe(1);
    expect((await runtime.getRun(runId))?.status).toBe("completed");

    // Subsequent approve+resume cycles are no-ops (run is already terminal).
    for (let i = 0; i < 4; i++) {
      await runtime.resumeRun({ kind: "approval", runId, approvalId: row.actionId, decision: "approved" }).catch(() => {});
      await runtime.drainQueue();
    }
    expect(tools.getCallCount("danger")).toBe(1); // no double-fire
    expect((await runtime.getRun(runId))?.status).toBe("completed");
  });
});
