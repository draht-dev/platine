// SPDX-License-Identifier: Apache-2.0
/**
 * make-executor.test.ts — TASK 1.4 acceptance test.
 *
 * Drives a run end-to-end through the SAME pieces makeExecutorHandler wires
 * together (buildToolRegistry + RealToolsDispatcher + driveRecords), but with
 * Memory* seam fakes standing in for the AWS adapters (DynamoStorage /
 * EventBridgeBus / SqsQueue), so this runs with no network and no credentials.
 *
 * makeExecutorHandler's own AWS-wired construction (buildAwsDeps) is
 * intentionally NOT invoked here — that requires real DynamoDB/SQS/EventBridge
 * clients and is exercised by the real-AWS deploy probes instead. What THIS
 * test proves is the part unique to TASK 1.4: a tool node dispatched through
 * RealToolsDispatcher(buildToolRegistry(workflow)) returns the tool's REAL
 * computed output (not the legacy StubToolsDispatcher's `{}`), and an agent
 * node actually invokes the injected Model.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow, _resetNodeCounter } from "@draht/core/define-workflow";
import { buildToolRegistry } from "@draht/core/compile";
import type { Manifest } from "@draht/core/manifest";
import type { TenantId, RunId, Model, ModelRequest, ModelStreamEvent, Usage } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import {
  MemoryStorage,
  MemoryQueue,
  MemoryBus,
  MemoryTenancy,
  FakeApprovalsCoordinator,
  FakeToolsDispatcher,
} from "../runtime-local.js";
import { RealToolsDispatcher } from "../tools-dispatcher.js";
import { driveRecords, type SQSEvent, type LambdaContext } from "./deps.js";
import type { ExecutorDeps } from "../executor.js";
import { wrapStorageWithToolRegistryCheck } from "./make-executor.js";

// ---------------------------------------------------------------------------
// A Model that counts invocations (proves "the model was invoked").
// ---------------------------------------------------------------------------

class CountingScriptedModel implements Model {
  calls = 0;
  private readonly usage: Usage = { inputTokens: 11, outputTokens: 7 };

  async chat(req: ModelRequest): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    this.calls++;
    return {
      type: "done",
      stopReason: "end_turn",
      text: "done",
      toolCalls: [],
      usage: { ...this.usage },
      modelId: req.modelId,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await this.chat(req);
  }

  supports(): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Fixed LambdaContext with plenty of remaining time (no soft-budget hit).
// ---------------------------------------------------------------------------

function makeLambdaContext(): LambdaContext {
  return { getRemainingTimeInMillis: () => 10 * 60 * 1000 };
}

const TENANT = DEFAULT_TENANT;

describe("make-executor pipeline — real tool execution + model invocation (TASK 1.4)", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("drives a run end-to-end: SIDEEFFECT# ledger holds the tool's real output, model was invoked", async () => {
    // 1. A real WorkflowDef with one real tool (doubles its input) — the SAME
    //    kind of ToolDef.execute() closure a user would author.
    const doubleTool = defineTool({
      description: "doubles a number",
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ doubled: z.number() }),
      execute: async ({ n }) => ({ doubled: n * 2 }),
    });

    const wf = defineWorkflow((b) => {
      const t = b.trigger({ type: "manual", payload: z.object({ n: z.number() }) });
      const c = b.node(doubleTool, t, (p) => ({ n: p.n }));
      return b.output(c);
    });

    const toolNode = wf.nodes.find((n) => n.kind === "tool");
    expect(toolNode).toBeDefined();
    const toolId = `tool_${toolNode!.id}`;

    // 2. Hand-craft a Manifest with the real tool node PLUS an agent node
    //    (drive()'s agent branch reads manifest.agent — the same pattern
    //    executor.test.ts's own makeManifest()/makeTwoStepManifest() use).
    const agentId = "make-executor-test-agent";
    const manifest: Manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_make_executor_test",
      kind: "workflow",
      agent: {
        agentId,
        name: "Make Executor Test Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:abc", inline: "Test agent" },
        skills: [],
        maxIterations: 3,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [
        {
          toolId,
          name: toolId,
          description: "doubles a number",
          kind: "local",
          inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
          requiresApproval: false,
          dangerous: false,
        },
      ],
      nodes: [
        { nodeId: "compute", kind: "tool", toolRef: toolId, requiresApproval: false, params: {}, outputSchema: [] },
        { nodeId: "respond", kind: "agent", agentRef: agentId, outputSchema: [] },
      ],
      edges: [{ edgeId: "e1", source: "compute", target: "respond" }],
      resources: {
        needsHttpEgress: false,
        needsBedrock: false,
        needsEventBus: true,
        secrets: [],
        extraIam: [],
      },
      resume: { via: "api", holdsApproval: false },
    };

    // 3. Bootstrap MemoryStorage: pinned manifest + RUN row + seeded trigger input.
    const storage = new MemoryStorage();
    const runId = "run_make_executor_1" as RunId;
    await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    await storage.ensureRun({
      tenantId: TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await storage.appendCheckpoint({
      tenantId: TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: { n: 21 },
    });

    // 4. The SAME composition makeExecutorHandler wires: buildToolRegistry(workflow)
    //    → RealToolsDispatcher — with Memory* fakes standing in for AWS adapters.
    const registry = buildToolRegistry(wf);
    const tools = new RealToolsDispatcher(registry);
    const model = new CountingScriptedModel();
    const bus = new MemoryBus();
    const tenancy = new MemoryTenancy();
    const queue = new MemoryQueue();
    const approvals = new FakeApprovalsCoordinator(storage);

    const deps: ExecutorDeps = { storage, model, eventBus: bus, tenancy, queue, tools, approvals };

    // 5. Drive via the SAME per-record loop the Lambda handler uses.
    const event: SQSEvent = {
      Records: [{ body: JSON.stringify({ runId, tenantId: TENANT, continuationCount: 0 }) }],
    };
    await driveRecords(event, makeLambdaContext(), deps);

    // 6. Assertions.
    const run = await storage.getRun(TENANT, runId);
    expect(run?.status).toBe("completed");

    const ledgered = await storage.hasSideEffect(TENANT, runId, "compute");
    expect(ledgered).not.toBeNull();
    // The REAL computed output (21 * 2 = 42) — NOT the legacy StubToolsDispatcher's `{}`.
    expect(ledgered?.result).toEqual({ doubled: 42 });

    expect(model.calls).toBeGreaterThan(0);
  });

  it("throws (per-record error swallow) when the tool is unregistered — run is NOT silently completed with a stub result", async () => {
    const agentId = "make-executor-unregistered-agent";
    const manifest: Manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_unreg",
      kind: "workflow",
      agent: {
        agentId,
        name: "Unregistered Tool Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:abc", inline: "Test agent" },
        skills: [],
        maxIterations: 3,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [],
      nodes: [
        { nodeId: "compute", kind: "tool", toolRef: "tool_not_in_registry", requiresApproval: false, params: {}, outputSchema: [] },
      ],
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

    const storage = new MemoryStorage();
    const runId = "run_make_executor_unreg" as RunId;
    await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    await storage.ensureRun({
      tenantId: TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await storage.appendCheckpoint({
      tenantId: TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: {},
    });

    // Empty registry — the tool is NOT registered.
    const tools = new RealToolsDispatcher(new Map());
    const deps: ExecutorDeps = {
      storage,
      model: new CountingScriptedModel(),
      eventBus: new MemoryBus(),
      tenancy: new MemoryTenancy(),
      queue: new MemoryQueue(),
      tools,
      approvals: new FakeApprovalsCoordinator(storage),
    };

    const event: SQSEvent = {
      Records: [{ body: JSON.stringify({ runId, tenantId: TENANT, continuationCount: 0 }) }],
    };

    // driveRecords swallows per-record errors (matches the Lambda handler contract) —
    // it must NOT throw, but the run must NOT be silently marked completed either.
    await expect(driveRecords(event, makeLambdaContext(), deps)).resolves.toBeUndefined();

    const run = await storage.getRun(TENANT, runId);
    expect(run?.status).not.toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// SHOULD-FIX 3b — registry-vs-manifest cross-check at first record processing
// ---------------------------------------------------------------------------

describe("wrapStorageWithToolRegistryCheck (SHOULD-FIX 3b)", () => {
  it("throws a descriptive error listing the missing toolId BEFORE any node dispatches — the earlier real tool node's side effect never fires", async () => {
    const agentId = "make-executor-registry-mismatch-agent";
    // Two tool nodes in sequence: "prep" (registered) → "danger" (NOT registered).
    // If the cross-check works, "prep" must NEVER dispatch — the mismatch is
    // caught before the scheduling loop runs ANY node, not just the missing one.
    const manifest: Manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_registry_mismatch",
      kind: "workflow",
      agent: {
        agentId,
        name: "Registry Mismatch Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:abc", inline: "Test agent" },
        skills: [],
        maxIterations: 3,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [
        {
          toolId: "tool_prep",
          name: "tool_prep",
          description: "prep step",
          kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false,
          dangerous: false,
        },
        {
          toolId: "tool_danger_MISSING",
          name: "tool_danger_MISSING",
          description: "not actually registered",
          kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false,
          dangerous: true,
        },
      ],
      nodes: [
        { nodeId: "prep", kind: "tool", toolRef: "tool_prep", requiresApproval: false, params: {}, outputSchema: [] },
        { nodeId: "danger", kind: "tool", toolRef: "tool_danger_MISSING", requiresApproval: false, params: {}, outputSchema: [] },
      ],
      edges: [{ edgeId: "e1", source: "prep", target: "danger" }],
      resources: {
        needsHttpEgress: false,
        needsBedrock: false,
        needsEventBus: true,
        secrets: [],
        extraIam: [],
      },
      resume: { via: "api", holdsApproval: false },
    };

    const rawStorage = new MemoryStorage();
    const runId = "run_registry_mismatch" as RunId;
    await rawStorage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    await rawStorage.ensureRun({
      tenantId: TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await rawStorage.appendCheckpoint({
      tenantId: TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: {},
    });

    // Registry only has "tool_prep" — mirrors a stale/mismatched bundled workflow.ts.
    const registry = new Map([["tool_prep", {}]]);
    const storage = wrapStorageWithToolRegistryCheck(rawStorage, registry);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_prep", async () => ({ prepped: true }));
    // "tool_danger_MISSING" is deliberately never registered on `tools` either
    // — but that's irrelevant: the cross-check must fire before dispatch even
    // reaches "prep", so "prep" must show zero calls.

    const deps: ExecutorDeps = {
      storage,
      model: new CountingScriptedModel(),
      eventBus: new MemoryBus(),
      tenancy: new MemoryTenancy(),
      queue: new MemoryQueue(),
      tools,
      approvals: new FakeApprovalsCoordinator(rawStorage),
    };

    const event: SQSEvent = {
      Records: [{ body: JSON.stringify({ runId, tenantId: TENANT, continuationCount: 0 }) }],
    };

    // driveRecords swallows the per-record error (DLQs just this record with
    // a clear message) — it must not throw or crash the whole batch.
    await expect(driveRecords(event, makeLambdaContext(), deps)).resolves.toBeUndefined();

    // The earlier, REGISTERED "prep" tool node must NEVER have dispatched —
    // proving the check fires before ANY node of the run is scheduled, not
    // just at the specific missing-tool node.
    expect(tools.getCallCount("tool_prep")).toBe(0);

    const run = await rawStorage.getRun(TENANT, runId);
    expect(run?.status).not.toBe("completed");
  });

  it("is a transparent passthrough when the registry covers every pinned tool — the run completes normally", async () => {
    const agentId = "make-executor-registry-ok-agent";
    const manifest: Manifest = {
      schemaVersion: "1.0.0",
      revision: "rev_registry_ok",
      kind: "workflow",
      agent: {
        agentId,
        name: "Registry OK Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:abc", inline: "Test agent" },
        skills: [],
        maxIterations: 3,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [
        {
          toolId: "tool_prep",
          name: "tool_prep",
          description: "prep step",
          kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false,
          dangerous: false,
        },
      ],
      nodes: [
        { nodeId: "prep", kind: "tool", toolRef: "tool_prep", requiresApproval: false, params: {}, outputSchema: [] },
      ],
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

    const rawStorage = new MemoryStorage();
    const runId = "run_registry_ok" as RunId;
    await rawStorage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    await rawStorage.ensureRun({
      tenantId: TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await rawStorage.appendCheckpoint({
      tenantId: TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: {},
    });

    const registry = new Map([["tool_prep", {}]]);
    const storage = wrapStorageWithToolRegistryCheck(rawStorage, registry);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_prep", async () => ({ prepped: true }));

    const deps: ExecutorDeps = {
      storage,
      model: new CountingScriptedModel(),
      eventBus: new MemoryBus(),
      tenancy: new MemoryTenancy(),
      queue: new MemoryQueue(),
      tools,
      approvals: new FakeApprovalsCoordinator(rawStorage),
    };

    const event: SQSEvent = {
      Records: [{ body: JSON.stringify({ runId, tenantId: TENANT, continuationCount: 0 }) }],
    };

    await driveRecords(event, makeLambdaContext(), deps);

    expect(tools.getCallCount("tool_prep")).toBe(1);
    const run = await rawStorage.getRun(TENANT, runId);
    expect(run?.status).toBe("completed");
  });
});
