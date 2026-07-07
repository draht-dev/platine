// SPDX-License-Identifier: Apache-2.0
/**
 * compile.test.ts — buildToolRegistry() acceptance tests.
 *
 * buildToolRegistry(wf) is the SOLE writer of the "tool_" + node.id key
 * scheme, shared by compileWorkflow's own tool collection (so the two can
 * never drift) and by @draht/runtime-aws's RealToolsDispatcher (built from
 * the WorkflowDef at deploy/dev time, since ToolDef.execute() closures are
 * NOT serialized into the Manifest).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "./define-tool.js";
import { defineWorkflow, _resetNodeCounter } from "./define-workflow.js";
import { buildToolRegistry } from "./compile.js";
import { parseManifest } from "./manifest/index.js";

const classifyTool = defineTool({
  description: "classify ticket",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({
    summary: z.string(),
    severity: z.enum(["low", "med", "high"]),
  }),
  execute: async ({ body }) => ({
    summary: body.slice(0, 80),
    severity: "high" as const,
  }),
});

const createTicketTool = defineTool({
  description: "open ticket",
  inputSchema: z.object({
    subject: z.string(),
    priority: z.enum(["low", "med", "high"]),
  }),
  needsApproval: true,
  execute: async (_i) => ({ ticketId: "t_1" }),
});

describe("buildToolRegistry", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("registry keys match compiled manifest.tools toolIds", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      const t2 = b.node(createTicketTool, c, (out) => ({
        subject: out.summary,
        priority: out.severity,
      }));
      return b.output(t2);
    });

    const manifest = wf.compile({
      agentId: "support-triage",
      name: "Support Triage",
    });

    const registry = buildToolRegistry(wf);

    const manifestToolIds = manifest.tools.map((t) => t.toolId).sort();
    const registryKeys = [...registry.keys()].sort();

    expect(registryKeys).toEqual(manifestToolIds);
    expect(registryKeys.length).toBe(2);
  });

  it("each registry value's .execute is a function", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      const t2 = b.node(createTicketTool, c, (out) => ({
        subject: out.summary,
        priority: out.severity,
      }));
      return b.output(t2);
    });

    const registry = buildToolRegistry(wf);

    expect(registry.size).toBeGreaterThan(0);
    for (const toolDef of registry.values()) {
      expect(typeof toolDef.execute).toBe("function");
    }
  });

  it("returns an empty registry for a workflow with no tool nodes", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ body: z.string() }),
      });
      return b.output(t);
    });

    const registry = buildToolRegistry(wf);
    expect(registry.size).toBe(0);
  });

  it("compileWorkflow's own tool collection uses the identical key scheme (no drift)", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      return b.output(c);
    });

    const registry = buildToolRegistry(wf);
    const toolNode = wf.nodes.find((n) => n.kind === "tool");
    expect(toolNode).toBeDefined();
    expect(registry.has(`tool_${toolNode!.id}`)).toBe(true);

    const manifest = wf.compile({ agentId: "single-tool" });
    expect(manifest.nodes.find((n) => n.kind === "tool")?.toolRef).toBe(
      `tool_${toolNode!.id}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Fanout elementSubgraph — task 2.3
// ---------------------------------------------------------------------------

const upperTool = defineTool({
  description: "uppercase a string field",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ body: z.string() }),
  execute: async ({ body }) => ({ body: body.toUpperCase() }),
});

describe("compileWorkflow — fanout elementSubgraph", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("compiles a fanout workflow to a non-empty elementSubgraph whose members are real manifest nodes", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ items: z.array(z.object({ body: z.string() })) }),
      });
      const arr = b.transform(t, (p) => p.items);
      const fh = b.split(arr);
      const processed = b.fanout(fh, (item) => b.node(upperTool, item, (x) => ({ body: x.body })));
      return b.output(processed);
    });

    const manifest = wf.compile({ agentId: "fanout-wf" });

    const foundFanoutNode = manifest.nodes.find((n) => n.kind === "fanout");
    expect(foundFanoutNode).toBeDefined();
    if (foundFanoutNode === undefined || foundFanoutNode.kind !== "fanout") {
      throw new Error("expected a fanout node in the compiled manifest");
    }
    const fanoutManifestNode = foundFanoutNode;

    // elementSubgraph is non-empty (the old dead mockBuilder always emitted []).
    expect(fanoutManifestNode.elementSubgraph.length).toBeGreaterThan(0);

    // Every member id is an addressable, validated manifest node.
    const manifestNodeIds = new Set(manifest.nodes.map((n) => n.nodeId));
    for (const memberId of fanoutManifestNode.elementSubgraph) {
      expect(manifestNodeIds.has(memberId)).toBe(true);
    }

    // The member is the sub-recorded tool node — buildToolRegistry must find its tool.
    const memberNode = manifest.nodes.find(
      (n) => n.nodeId === fanoutManifestNode.elementSubgraph[0],
    );
    expect(memberNode?.kind).toBe("tool");

    const registry = buildToolRegistry(wf);
    expect(registry.size).toBe(1);

    // Round-trips through parseManifest without error.
    expect(() => parseManifest(manifest)).not.toThrow();
    const reparsed = parseManifest(manifest);
    expect(reparsed.revision).toBe(manifest.revision);
  });
});
