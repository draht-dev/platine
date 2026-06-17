// SPDX-License-Identifier: Apache-2.0
/**
 * flush-swallow.adversarial.test.ts — verifies the flush error propagation fix.
 *
 * HOLE #2 FIX: When appendCheckpoint REJECTS, the error is no longer swallowed.
 * The run transitions to 'failed' rather than 'completed' with missing step data.
 * This prevents silent data corruption where a run reports COMPLETED but a step
 * checkpoint was never persisted.
 */
import { describe, it, expect } from "vitest";
import type { RunId, StepCheckpoint } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { Manifest } from "@draht/core/manifest";
import { drive, type ExecutorContext, type ExecutorDeps } from "./executor.js";
import { MemoryStorage, MemoryQueue, MemoryBus, MemoryTenancy, FakeToolsDispatcher, FakeApprovalsCoordinator } from "./runtime-local.js";
import { ScriptedModel } from "./fake-model.js";

const TENANT = DEFAULT_TENANT;
function mf(o: Partial<Manifest> = {}): Manifest {
  return { schemaVersion: "1.0.0", revision: "r", kind: "workflow",
    agent: { agentId: "a", name: "a", model: { provider: "anthropic", modelId: "m" }, instructionsRef: { contentHash: "sha256:x", inline: "t" }, skills: [], maxIterations: 3, maxToolCallsPerIteration: 3, circuitBreakerErrorThreshold: 5 },
    tenancy: { mode: "single" }, triggers: [{ type: "manual" }], channels: [], connections: [], tools: [], nodes: [], edges: [],
    resources: { needsHttpEgress: false, needsBedrock: false, needsEventBus: true, secrets: [], extraIam: [] },
    resume: { via: "api", holdsApproval: false }, ...o };
}
function deps(storage: MemoryStorage): ExecutorDeps {
  return { storage, model: new ScriptedModel([]), eventBus: new MemoryBus(), tenancy: new MemoryTenancy(), queue: new MemoryQueue(), tools: new FakeToolsDispatcher(), approvals: new FakeApprovalsCoordinator(storage) };
}
function ctx(runId: RunId): ExecutorContext { return { tenantId: TENANT, runId, deadlineAt: Date.now() + 600000, maxContinuations: 10, continuationCount: 0 }; }

describe("flush error propagation (HOLE #2 fix)", () => {
  it("a transform checkpoint that THROWS in appendCheckpoint causes run to FAIL, not complete silently", async () => {
    const storage = new MemoryStorage();
    const manifest = mf({ nodes: [{ nodeId: "t1", kind: "transform", transform: { type: "map", mappings: [{ from: "x", to: "y" }] }, outputSchema: [] }], edges: [] });
    const runId = "fs1" as RunId;
    await storage.putManifest("a", "r", JSON.stringify(manifest));
    await storage.ensureRun({ tenantId: TENANT, runId, manifestId: "a", manifestRevision: "r" });
    await storage.appendCheckpoint({ tenantId: TENANT, runId, stepId: "__trigger__", status: "completed", output: { x: 1 } });

    const realAppend = storage.appendCheckpoint.bind(storage);
    storage.appendCheckpoint = async (c: StepCheckpoint) => {
      if (c.stepId === "t1") throw new Error("disk full / conditional-check failed");
      return realAppend(c);
    };

    await drive(ctx(runId), deps(storage));
    const run = await storage.getRun(TENANT, runId);
    const t1 = run?.steps.find((s) => s.stepId === "t1");
    console.error(`[FLUSH-FIX] runStatus=${run?.status} t1Persisted=${t1 !== undefined}`);

    // FIX: the run must NOT report 'completed' when a step checkpoint failed to persist.
    // It must fail so the operator can detect data loss.
    expect(run?.status).toBe("failed");
    expect(run?.error).toMatch(/checkpoint flush failed/);
    // The step was not persisted (the append threw before it could write)
    expect(t1).toBeUndefined();
  });
});
