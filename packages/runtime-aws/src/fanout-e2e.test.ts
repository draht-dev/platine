// SPDX-License-Identifier: Apache-2.0
/**
 * fanout-e2e.test.ts — Phase 2 (task 2.4) end-to-end acceptance test.
 *
 * Authors a REAL fanout workflow with @draht/core's defineWorkflow DSL,
 * compiles it (compileWorkflow), and drives it through LocalRuntime with
 * RealToolsDispatcher (the user's actual tool `execute()` closures, wired via
 * buildToolRegistry(wf) — no manifest-side function serialization). Asserts
 * each item went through its REAL elementSubgraph (not a passthrough): the
 * tool actually ran per item, and per-item SIDEEFFECT# ledger rows exist.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow, _resetNodeCounter } from "@draht/core/define-workflow";
import { buildToolRegistry } from "@draht/core/compile";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { RunId } from "@draht/core/seams";
import { deriveRunId } from "./executor.js";
import { createLocalRuntime } from "./runtime-local.js";
import { RealToolsDispatcher } from "./tools-dispatcher.js";
import { ScriptedModel } from "./fake-model.js";

const doubleTool = defineTool({
  description: "doubles a number",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ n: z.number() }),
  execute: async ({ n }) => ({ n: n * 2 }),
});

const auditTool = defineTool({
  description: "records an audit trail entry for a doubled value (side output, not returned)",
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ audited: z.boolean() }),
  execute: async ({ n }) => ({ audited: true, n }),
});

describe("fanout e2e — LocalRuntime drives a real elementSubgraph", () => {
  it("each item is processed by its real subgraph, with per-item ledger rows", async () => {
    _resetNodeCounter();

    // The trigger payload IS the array (b.split() requires an already-array-
    // typed upstream handle) — this sidesteps compile.ts's separately-tracked
    // v1 limitation where a b.transform() mapper's actual field-selection
    // logic (e.g. `p => p.items`) is not reflected in the compiled manifest
    // (transform nodes always compile to an empty `{type:"map", mappings:[]}`
    // — out of scope for Phase 2/elementSubgraph). Task 2.4 only needs a real
    // split → fanout → elementSubgraph pipeline, which this exercises fully.
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.array(z.object({ n: z.number() })),
      });
      const fh = b.split(t);
      const processed = b.fanout(fh, (item) =>
        b.node(doubleTool, item, (x) => ({ n: x.n })),
      );
      return b.output(processed);
    });

    const manifest = wf.compile({ agentId: "fanout-e2e" });

    // The compiled manifest carries a non-empty elementSubgraph whose sole
    // member is the sub-recorded doubleTool node (task 2.3).
    const fanoutManifestNode = manifest.nodes.find((n) => n.kind === "fanout");
    expect(fanoutManifestNode).toBeDefined();
    if (fanoutManifestNode === undefined || fanoutManifestNode.kind !== "fanout") {
      throw new Error("expected a fanout node in the compiled manifest");
    }
    expect(fanoutManifestNode.elementSubgraph.length).toBe(1);
    const subNodeId = fanoutManifestNode.elementSubgraph[0]!;

    // Build the REAL tool registry from the WorkflowDef (never the Manifest —
    // execute() closures are not serialized) and wire it into LocalRuntime.
    const registry = buildToolRegistry(wf);
    const tools = new RealToolsDispatcher(registry);

    const { runtime, storage, queue } = createLocalRuntime({
      model: new ScriptedModel([]),
      tools,
    });

    await storage.putManifest(
      manifest.agent.agentId,
      manifest.revision,
      JSON.stringify(manifest),
    );

    const runId = deriveRunId("manual:fanout-e2e", "e2e-1") as RunId;

    // Seed the trigger checkpoint directly (bypassing LocalRuntime.submitRun's
    // `{...input, ...trigger.payload}` object-merge, which would flatten an
    // array input into numeric-keyed object props) and enqueue for drainQueue,
    // mirroring executor.test.ts's bootstrapRun + queue.enqueue pattern.
    await storage.ensureRun({
      tenantId: DEFAULT_TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await storage.appendCheckpoint({
      tenantId: DEFAULT_TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: [{ n: 1 }, { n: 2 }, { n: 3 }],
    });
    queue.enqueue(runId);

    await runtime.drainQueue();

    const run = await runtime.getRun(runId);
    expect(run?.status).toBe("completed");

    // Real subgraph execution, not passthrough: the doubling actually happened.
    const outputs = await storage.loadStepOutputs(DEFAULT_TENANT, runId);
    expect(outputs.get(fanoutManifestNode.nodeId)).toEqual([
      { n: 2 },
      { n: 4 },
      { n: 6 },
    ]);

    // Per-item SIDEEFFECT# ledger rows prove each item dispatched the REAL
    // tool exactly once, keyed by "<fanoutNodeId>#<idx>#<subNodeId>".
    for (let idx = 0; idx < 3; idx++) {
      const ledgerRow = await storage.hasSideEffect(
        DEFAULT_TENANT,
        runId,
        `${fanoutManifestNode.nodeId}#${idx}#${subNodeId}`,
      );
      expect(ledgerRow).not.toBeNull();
      expect(ledgerRow?.result).toEqual({ n: (idx + 1) * 2 });
    }
  });

  it("SHOULD-FIX 4: body returns an INTERMEDIATE handle while a later-recorded audit node also exists — fanout output = the returned handle's output, NOT the audit node's", async () => {
    _resetNodeCounter();

    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.array(z.object({ n: z.number() })),
      });
      const fh = b.split(t);
      const processed = b.fanout(fh, (item) => {
        // "doubled" is the handle the body RETURNS — it's the fanout's
        // intended per-item output.
        const doubled = b.node(doubleTool, item, (x) => ({ n: x.n }));
        // "audited" is recorded AFTER "doubled" but is NOT what's returned —
        // it's a side output (e.g. an audit-trail write). Before the
        // SHOULD-FIX 4 fix, the executor picked "whichever sub-node sorts
        // last in topo order", which is THIS node (since it's downstream of
        // "doubled") — silently collecting the wrong output.
        b.node(auditTool, doubled, (x) => ({ n: x.n }));
        return doubled;
      });
      return b.output(processed);
    });

    const manifest = wf.compile({ agentId: "fanout-e2e-terminal" });
    const fanoutManifestNode = manifest.nodes.find((n) => n.kind === "fanout");
    expect(fanoutManifestNode).toBeDefined();
    if (fanoutManifestNode === undefined || fanoutManifestNode.kind !== "fanout") {
      throw new Error("expected a fanout node in the compiled manifest");
    }
    // Both sub-nodes are present in elementSubgraph...
    expect(fanoutManifestNode.elementSubgraph.length).toBe(2);
    // ...but terminalSubNodeId identifies "doubled" (the body's actual return),
    // NOT "audited" (the last-recorded/last-topo-order member).
    const doubledSubNodeId = fanoutManifestNode.elementSubgraph[0]!;
    const auditedSubNodeId = fanoutManifestNode.elementSubgraph[1]!;
    expect(fanoutManifestNode.terminalSubNodeId).toBe(doubledSubNodeId);
    expect(fanoutManifestNode.terminalSubNodeId).not.toBe(auditedSubNodeId);

    const registry = buildToolRegistry(wf);
    const tools = new RealToolsDispatcher(registry);

    const { runtime, storage, queue } = createLocalRuntime({
      model: new ScriptedModel([]),
      tools,
    });

    await storage.putManifest(
      manifest.agent.agentId,
      manifest.revision,
      JSON.stringify(manifest),
    );

    const runId = deriveRunId("manual:fanout-e2e-terminal", "terminal-1") as RunId;
    await storage.ensureRun({
      tenantId: DEFAULT_TENANT,
      runId,
      manifestId: manifest.agent.agentId,
      manifestRevision: manifest.revision,
    });
    await storage.appendCheckpoint({
      tenantId: DEFAULT_TENANT,
      runId,
      stepId: "__trigger__",
      status: "completed",
      output: [{ n: 1 }, { n: 2 }],
    });
    queue.enqueue(runId);

    await runtime.drainQueue();

    const run = await runtime.getRun(runId);
    expect(run?.status).toBe("completed");

    // The fanout's collected output must be "doubled"'s output ({ n }), NOT
    // "audited"'s output ({ audited: true, n }).
    const outputs = await storage.loadStepOutputs(DEFAULT_TENANT, runId);
    expect(outputs.get(fanoutManifestNode.nodeId)).toEqual([{ n: 2 }, { n: 4 }]);

    // Both sub-nodes still actually ran (the audit side-effect is NOT skipped
    // — it's just not what the fanout collects as its result).
    for (let idx = 0; idx < 2; idx++) {
      const doubledLedger = await storage.hasSideEffect(
        DEFAULT_TENANT,
        runId,
        `${fanoutManifestNode.nodeId}#${idx}#${doubledSubNodeId}`,
      );
      expect(doubledLedger).not.toBeNull();
      const auditedLedger = await storage.hasSideEffect(
        DEFAULT_TENANT,
        runId,
        `${fanoutManifestNode.nodeId}#${idx}#${auditedSubNodeId}`,
      );
      expect(auditedLedger).not.toBeNull();
    }
  });
});
