// SPDX-License-Identifier: Apache-2.0
/**
 * durability.adversarial.test.ts — SKEPTIC stress tests of the step-boundary
 * exactly-once + resume claim on the LOCAL executor.
 *
 * Attacks: double-fire (post-effect/pre-ledger), resume correctness,
 * approval idempotence/re-hold, flush ordering drain, continuation idempotence.
 */

import { describe, it, expect } from "vitest";
import type { TenantId, RunId, RunStatus, StepCheckpoint, SideEffectRow } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { Manifest } from "@draht/core/manifest";
import {
  drive,
  type ExecutorContext,
  type ExecutorDeps,
} from "./executor.js";
import {
  MemoryStorage,
  MemoryQueue,
  MemoryBus,
  MemoryTenancy,
  FakeToolsDispatcher,
  FakeApprovalsCoordinator,
  createLocalRuntime,
} from "./runtime-local.js";
import { ScriptedModel } from "./fake-model.js";

const TENANT = DEFAULT_TENANT;

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: "1.0.0",
    revision: "rev_adv",
    kind: "workflow",
    agent: {
      agentId: "adv-agent",
      name: "Adv Agent",
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      instructionsRef: { contentHash: "sha256:abc", inline: "test" },
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
    nodes: [],
    edges: [],
    resources: { needsHttpEgress: false, needsBedrock: false, needsEventBus: true, secrets: [], extraIam: [] },
    resume: { via: "api", holdsApproval: false },
    ...overrides,
  };
}

function toolNode(nodeId: string, toolRef: string, requiresApproval = false) {
  return { nodeId, kind: "tool" as const, toolRef, requiresApproval, params: {}, outputSchema: [] };
}

function toolDef(toolId: string, requiresApproval = false) {
  return {
    toolId, name: toolId, description: "t", kind: "local" as const,
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    requiresApproval, dangerous: false,
  };
}

async function bootstrap(storage: MemoryStorage, manifest: Manifest, runId: RunId, input: Record<string, unknown> = {}): Promise<void> {
  await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
  await storage.ensureRun({ tenantId: TENANT, runId, manifestId: manifest.agent.agentId, manifestRevision: manifest.revision });
  await storage.appendCheckpoint({ tenantId: TENANT, runId, stepId: "__trigger__", status: "completed", output: input });
}

function makeCtx(runId: RunId, overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return { tenantId: TENANT, runId, deadlineAt: Date.now() + 10 * 60 * 1000, maxContinuations: 10, continuationCount: 0, ...overrides };
}

function makeDeps(storage: MemoryStorage, opts: { model?: ScriptedModel; tools?: FakeToolsDispatcher; tenancy?: MemoryTenancy; queue?: MemoryQueue; bus?: MemoryBus } = {}): ExecutorDeps {
  const queue = opts.queue ?? new MemoryQueue();
  const bus = opts.bus ?? new MemoryBus();
  const tenancy = opts.tenancy ?? new MemoryTenancy();
  const tools = opts.tools ?? new FakeToolsDispatcher();
  const approvals = new FakeApprovalsCoordinator(storage);
  const model = opts.model ?? new ScriptedModel([{ stopReason: "end_turn", text: "ok" }]);
  return { storage, model, eventBus: bus, tenancy, queue, tools, approvals };
}

// ===========================================================================
// ATTACK 1: DOUBLE-FIRE
// ===========================================================================
describe("ATTACK 1: double-fire", () => {
  it("A1a: plain redelivery of a COMPLETED step does NOT re-fire (ledger pre-check)", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({ tools: [toolDef("se")], nodes: [toolNode("s1", "se")], edges: [] });
    const runId = "a1a" as RunId;
    await bootstrap(storage, manifest, runId);
    const tools = new FakeToolsDispatcher();
    let fires = 0;
    tools.register("se", async () => { fires++; return { fires }; });
    const deps = makeDeps(storage, { tools });

    await drive(makeCtx(runId), deps);
    expect(fires).toBe(1);
    // Now FORCE a re-drive while NOT terminal: reset run status to running but keep the ledger.
    // This simulates a redelivery that arrives after the step committed but before the
    // run reached a terminal status (mid-step crash recovery).
    (await storage.getRun(TENANT, runId))!.status = "running";
    await drive(makeCtx(runId), deps);
    expect(fires).toBe(1); // ledger pre-check must prevent re-fire
  });

  it("A1b: CHARACTERIZE the post-effect/pre-ledger window — tool effect done, crash BEFORE ledger commit, redeliver => DOUBLE FIRE", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({ tools: [toolDef("se")], nodes: [toolNode("s1", "se")], edges: [] });
    const runId = "a1b" as RunId;
    await bootstrap(storage, manifest, runId);

    const tools = new FakeToolsDispatcher();
    let fires = 0;
    tools.register("se", async () => { fires++; return { fires }; });

    // Wrap storage to simulate a CRASH in the window between external effect completing
    // (tools.execute returned) and commitStepWithSideEffect persisting.
    let crashOnCommit = true;
    const crashingStorage = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === "commitStepWithSideEffect") {
          return async (...args: unknown[]) => {
            if (crashOnCommit) { throw new Error("CRASH in post-effect/pre-ledger window"); }
            return (target.commitStepWithSideEffect as (...a: unknown[]) => Promise<void>).apply(target, args);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as unknown as MemoryStorage;

    const deps = makeDeps(crashingStorage, { tools });
    // First drive: effect fires, then commit throws -> the run is left non-terminal, ledger empty
    await expect(drive(makeCtx(runId), deps)).rejects.toThrow(/CRASH/);
    expect(fires).toBe(1);
    const ledgerAfterCrash = await storage.hasSideEffect(TENANT, runId, "s1");
    expect(ledgerAfterCrash).toBeNull(); // no ledger row -> pre-check will NOT catch redelivery

    // Redelivery: crash window healed, but no ledger exists yet -> pre-check passes -> RE-FIRE
    crashOnCommit = false;
    (await storage.getRun(TENANT, runId))!.status = "running";
    await drive(makeCtx(runId), deps);
    expect(fires).toBe(2); // DOUBLE FIRE — this is the DOCUMENTED irreducible window (plan §A.2 / rule 2)
  });
});

// ===========================================================================
// ATTACK 2: RESUME CORRECTNESS
// ===========================================================================
describe("ATTACK 2: resume correctness", () => {
  it("A2a: resume rehydrates ALL completed step outputs (full Map), and a multi-upstream merge node sees them", async () => {
    // a -> c, b -> c (c merges a+b). Pre-complete a and b. Kill. Resume should NOT re-run a/b
    // and c must see BOTH outputs (proves loadStepOutputs returns full Map, not a single previousOutput).
    const storage = new MemoryStorage();
    const manifest = makeManifest({
      tools: [toolDef("ta"), toolDef("tb"), toolDef("tc")],
      nodes: [toolNode("a", "ta"), toolNode("b", "tb"), toolNode("c", "tc")],
      edges: [
        { edgeId: "e1", source: "a", target: "c" },
        { edgeId: "e2", source: "b", target: "c" },
      ],
    });
    const runId = "a2a" as RunId;
    await bootstrap(storage, manifest, runId);

    const tools = new FakeToolsDispatcher();
    const aFires = { n: 0 }; const bFires = { n: 0 };
    tools.register("ta", async () => { aFires.n++; return { fromA: 1 }; });
    tools.register("tb", async () => { bFires.n++; return { fromB: 2 }; });
    let cSawInput: Record<string, unknown> | undefined;
    tools.register("tc", async (input) => { cSawInput = input; return { merged: true }; });

    // Pre-complete a and b (simulating a checkpoint before crash)
    for (const [nid, out] of [["a", { fromA: 1 }], ["b", { fromB: 2 }]] as const) {
      await storage.commitStepWithSideEffect(
        { tenantId: TENANT, runId, stepId: nid, status: "completed", output: out, idempotencyKey: `${runId}#${nid}` },
        { tenantId: TENANT, runId, nodeId: nid, idempotencyKey: `${runId}#${nid}`, toolName: `t${nid}`, result: out },
      );
    }

    const deps = makeDeps(storage, { tools });
    await drive(makeCtx(runId), deps);

    expect(aFires.n).toBe(0); // a NOT re-run
    expect(bFires.n).toBe(0); // b NOT re-run
    expect((await storage.getRun(TENANT, runId))?.status).toBe("completed");
    // c must have seen BOTH upstream outputs merged
    expect(cSawInput).toEqual({ fromA: 1, fromB: 2 });
  });

  it("A2b: kill mid-run via deadline, then resume — completed step NOT re-run, run completes", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({
      tools: [toolDef("t")],
      nodes: [toolNode("s1", "t"), toolNode("s2", "t")],
      edges: [{ edgeId: "e1", source: "s1", target: "s2" }],
    });
    const runId = "a2b" as RunId;
    await bootstrap(storage, manifest, runId);

    const tools = new FakeToolsDispatcher();
    const callsByKey: string[] = [];
    tools.register("t", async (_in, ctx) => { callsByKey.push(ctx.idempotencyKey); return { k: ctx.idempotencyKey }; });

    const queue = new MemoryQueue();
    const deps = makeDeps(storage, { tools, queue });

    // Run with already-past deadline: drive should drain + enqueue continuation, doing NO work.
    await drive(makeCtx(runId, { deadlineAt: Date.now() - 1 }), deps);
    expect(callsByKey).toEqual([]); // nothing fired

    // Resume with a generous deadline: should run s1 then s2 exactly once each.
    await drive(makeCtx(runId), deps);
    expect((await storage.getRun(TENANT, runId))?.status).toBe("completed");
    expect(callsByKey).toEqual([`${runId}#s1`, `${runId}#s2`]);
  });
});

// ===========================================================================
// ATTACK 3: APPROVAL
// ===========================================================================
describe("ATTACK 3: approval", () => {
  it("A3a: redelivery while awaiting_approval does NOT re-hold or re-run the held tool", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({
      tools: [toolDef("danger", true)],
      nodes: [toolNode("g", "danger", true)],
      edges: [],
      resume: { via: "api", holdsApproval: true },
    });
    const runId = "a3a" as RunId;
    await bootstrap(storage, manifest, runId);
    const tools = new FakeToolsDispatcher();
    tools.register("danger", async () => ({ ok: true }));
    const deps = makeDeps(storage, { tools });

    await drive(makeCtx(runId), deps);
    expect((await storage.getRun(TENANT, runId))?.status).toBe("awaiting_approval");
    expect(storage.getApprovals().size).toBe(1);
    expect(tools.getCallCount("danger")).toBe(0);

    // redeliver while held
    await drive(makeCtx(runId), deps);
    expect(storage.getApprovals().size).toBe(1); // NO duplicate approval
    expect(tools.getCallCount("danger")).toBe(0); // tool NOT run
  });

  it("A3b: approval resolution idempotent on (runId,stepId) — createPendingApproval dedupes, hold() returns the SAME actionId (no dangling actionId)", async () => {
    const storage = new MemoryStorage();
    const approvals = new FakeApprovalsCoordinator(storage);
    const id1 = await approvals.hold({ runId: "r" as RunId, tenantId: TENANT, nodeId: "n", toolName: "t", paramsJson: "{}", idempotencyKey: "k" });
    const id2 = await approvals.hold({ runId: "r" as RunId, tenantId: TENANT, nodeId: "n", toolName: "t", paramsJson: "{}", idempotencyKey: "k" });
    // MAJOR 2 fix: hold() now checks getApprovalByStep BEFORE minting a new
    // actionId, so a second hold() for the same (runId, nodeId) returns the
    // EXISTING actionId rather than a freshly-minted one that would never be
    // stored (the old behavior left a "dangling" actionId the caller could
    // never resolve or look up — see runtime-local.ts's hold()).
    expect(id1).toBe(id2);
    expect(storage.getApprovals().size).toBe(1);
  });

  it("A3c: FIXED — after approval granted + resume, drive() clears the gate and the tool runs exactly once", async () => {
    // Full end-to-end via LocalRuntime. No manual ledger pre-commit (unlike old executor.test.ts workaround).
    const { runtime, storage, tools } = createLocalRuntime({ model: new ScriptedModel([]) });
    tools.register("danger", async () => ({ executed: true }));
    const manifest = makeManifest({
      tools: [toolDef("danger", true)],
      nodes: [toolNode("g", "danger", true)],
      edges: [],
      resume: { via: "api", holdsApproval: true },
    });
    await storage.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
    const runId = "a3c" as RunId;
    await runtime.submitRun({
      runId, manifestId: manifest.agent.agentId, manifestRevision: manifest.revision,
      tenantId: TENANT, trigger: { type: "manual" }, input: {}, chainDepth: 0,
    });
    await runtime.drainQueue();
    expect((await runtime.getRun(runId))?.status).toBe("awaiting_approval");
    expect(tools.getCallCount("danger")).toBe(0);

    // Approve via the public Runtime seam (the documented ResumeApproval path).
    const approvalRow = [...storage.getApprovals().values()][0]!;
    await runtime.resumeRun({ kind: "approval", runId, approvalId: approvalRow.actionId, decision: "approved", by: "tester" });
    await runtime.drainQueue();

    const finalStatus = (await runtime.getRun(runId))?.status;
    const fires = tools.getCallCount("danger");
    // FIX: getApprovalByStep check clears the hold gate when status==="approved".
    // Tool runs exactly once; run transitions to completed per plan §588.
    console.error(`[A3c-FIXED] after approval: status=${finalStatus} dangerFires=${fires}`);
    expect(fires).toBe(1);              // FIX: tool runs after approval
    expect(finalStatus).toBe("completed"); // FIX: run completes
  });
});

// ===========================================================================
// ATTACK 4: FLUSH ORDERING
// ===========================================================================
describe("ATTACK 4: flush ordering / drain before terminal", () => {
  it("A4a: a SLOW checkpoint is drained before the 'completed' terminal write", async () => {
    const storage = new MemoryStorage();
    // transform node uses checkpoint() (async-flush chain) rather than commitStepWithSideEffect.
    const manifest = makeManifest({
      nodes: [{ nodeId: "t1", kind: "transform", transform: { type: "map", mappings: [{ from: "x", to: "y" }] }, outputSchema: [] }],
      edges: [],
    });
    const runId = "a4a" as RunId;
    await bootstrap(storage, manifest, runId, { x: 99 });

    // Patch appendCheckpoint to delay the actual apply, so a naive (non-drained) terminal
    // write would land 'completed' BEFORE the step checkpoint is applied.
    const realAppend = storage.appendCheckpoint.bind(storage);
    let slowAppendStarted = false;
    let slowAppendFinished = false;
    storage.appendCheckpoint = async (c: StepCheckpoint) => {
      if (c.stepId === "t1") {
        slowAppendStarted = true;
        await new Promise((r) => setTimeout(r, 50));
        const res = await realAppend(c);
        slowAppendFinished = true;
        return res;
      }
      return realAppend(c);
    };

    // Patch setRunStatus to assert ordering at the moment 'completed' is written.
    const realSet = storage.setRunStatus.bind(storage);
    let completedObservedStepApplied: boolean | null = null;
    storage.setRunStatus = async (t, rid, status, fin) => {
      const res = await realSet(t, rid, status, fin);
      if (status === "completed") {
        const run = await realSet ? (await storage.getRun(t, rid)) : null;
        const stepApplied = run?.steps.some((s) => s.stepId === "t1" && s.status === "completed") ?? false;
        completedObservedStepApplied = stepApplied && slowAppendFinished;
      }
      return res;
    };

    const deps = makeDeps(storage);
    await drive(makeCtx(runId), deps);

    expect(slowAppendStarted).toBe(true);
    expect(slowAppendFinished).toBe(true);
    // At the time 'completed' was written, the slow checkpoint MUST already be applied.
    expect(completedObservedStepApplied).toBe(true);
    const run = await storage.getRun(TENANT, runId);
    expect(run?.status).toBe("completed");
    expect(run?.steps.find((s) => s.stepId === "t1")?.output).toEqual({ y: 99 });
  });

  it("A4b: a held approval drains its awaiting_approval checkpoint before the awaiting_approval status write", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({
      tools: [toolDef("danger", true)],
      nodes: [toolNode("g", "danger", true)],
      edges: [],
      resume: { via: "api", holdsApproval: true },
    });
    const runId = "a4b" as RunId;
    await bootstrap(storage, manifest, runId);
    const deps = makeDeps(storage);
    await drive(makeCtx(runId), deps);
    const run = await storage.getRun(TENANT, runId);
    expect(run?.status).toBe("awaiting_approval");
    // The step checkpoint with heldApprovalId must be present (drained) by the time status flips.
    const step = run?.steps.find((s) => s.stepId === "g");
    expect(step?.status).toBe("awaiting_approval");
    expect(step?.heldApprovalId).toBeDefined();
  });
});

// ===========================================================================
// ATTACK 5: CONTINUATION
// ===========================================================================
describe("ATTACK 5: soft-budget continuation", () => {
  it("A5a: continuation re-enqueues under SAME anchor (runId) and does not duplicate the run", async () => {
    const storage = new MemoryStorage();
    const manifest = makeManifest({ tools: [toolDef("t")], nodes: [toolNode("s1", "t")], edges: [] });
    const runId = "a5a" as RunId;
    await bootstrap(storage, manifest, runId);
    const queue = new MemoryQueue();
    const deps = makeDeps(storage, { queue });
    await drive(makeCtx(runId, { deadlineAt: Date.now() - 1 }), deps);
    const pending = (queue as unknown as { pending: Array<{ runId: RunId; continuationCount: number }> }).pending;
    expect(pending.length).toBe(1);
    expect(pending[0]!.runId).toBe(runId); // same anchor
    expect(pending[0]!.continuationCount).toBe(1);
  });

  it("A5b: maxContinuations stops the loop — repeated deadline hits eventually DLQ/fail, no infinite loop", async () => {
    const storage = new MemoryStorage();
    // A tool that, every time it's invoked, would need MORE work; but we force deadline-past
    // on every drive so it can never make progress -> must terminate at maxContinuations.
    const manifest = makeManifest({ tools: [toolDef("t")], nodes: [toolNode("s1", "t")], edges: [] });
    const runId = "a5b" as RunId;
    await bootstrap(storage, manifest, runId);
    const queue = new MemoryQueue();
    const deps = makeDeps(storage, { queue });

    // Drive in a bounded loop simulating the SQS consumer; deadline always in the past.
    // HOLE A FIX: No manual run.continuations mirroring needed. The queue carries the
    // continuationCount on each message; drive() reads it from ctx.continuationCount.
    // The loop just needs to extract continuationCount from the queue entry and pass
    // it in the ctx (exactly what MemoryQueue.drain does automatically).
    let iterations = 0;
    const MAX_CONT = 3;
    const HARD_STOP = 50; // adversarial guard: detect infinite re-enqueue
    while (iterations < HARD_STOP) {
      iterations++;
      const run = await storage.getRun(TENANT, runId);
      if (!run || run.status === "failed" || run.status === "completed") break;
      // consume the message (real SQS consumer behavior)
      const pending = (queue as unknown as { pending: Array<{ continuationCount: number }> }).pending;
      // Extract continuationCount from the queue entry — this is what the real SQS
      // consumer / MemoryQueue.drain does; no manual run.continuations write needed.
      const continuationCount = pending.length > 0 ? pending[0]!.continuationCount : 0;
      (queue as unknown as { pending: unknown[] }).pending = [];
      await drive(makeCtx(runId, { deadlineAt: Date.now() - 1, maxContinuations: MAX_CONT, continuationCount }), deps);
    }

    const run = await storage.getRun(TENANT, runId);
    expect(iterations).toBeLessThan(HARD_STOP); // did NOT loop forever
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/maxContinuations/);
    expect(queue.dlqEntries.length).toBeGreaterThan(0);
  });
});
