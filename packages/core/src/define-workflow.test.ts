// SPDX-License-Identifier: Apache-2.0
/**
 * T1 — define-workflow positive-path test.
 *
 * Builds a CORRECT 3-node workflow (trigger → classify agent → approval-gated tool),
 * mirrors the §3.2 example from the plan, and asserts:
 *
 *  1. It typechecks (the test itself is the type proof — tsc compiles it or fails).
 *  2. `.compile()` produces a Manifest that `parseManifest()` accepts.
 *  3. Edges and nodes are correct.
 *  4. Params templates reference the right upstream paths (e.g. "{{summary}}").
 *  5. The negative fan-out brand: passing a FanoutHandle where NodeHandle is
 *     expected is a TYPE ERROR (verified by the compile-time test in the comment
 *     below + the separate fixtures/miswire suite).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "./define-tool.js";
import { defineWorkflow, _resetNodeCounter } from "./define-workflow.js";
import { parseManifest } from "./manifest/index.js";

// ---------------------------------------------------------------------------
// Tool definitions (§3.2 example)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// T1 — positive path: CORRECT workflow builds and compiles
// ---------------------------------------------------------------------------

describe("defineWorkflow / compile — T1 positive path", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("typechecks: correct mapper types compile cleanly", () => {
    // This is the type proof — if tsc compiles this test, the types are correct.
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });

      // p: { body: string } — correct field access
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));

      // out: { summary: string; severity: "low"|"med"|"high" } — correct
      const t2 = b.node(createTicketTool, c, (out) => ({
        subject: out.summary,
        priority: out.severity,
      }));

      return b.output(t2);
    });

    // The workflow records nodes and edges
    expect(wf.nodes.length).toBeGreaterThan(0);
    expect(wf.edges.length).toBeGreaterThan(0);
  });

  it("records the correct number of nodes", () => {
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

    // trigger + tool_classify + tool_createTicket + output = 4 nodes
    expect(wf.nodes).toHaveLength(4);

    // Check node kinds
    const kinds = wf.nodes.map((n) => n.kind);
    expect(kinds).toContain("trigger");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("output");
  });

  it("records the correct edges", () => {
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

    // trigger → tool_1, tool_1 → tool_2, tool_2 → output = 3 edges
    expect(wf.edges).toHaveLength(3);

    // Each edge has source and target
    for (const edge of wf.edges) {
      expect(typeof edge.source).toBe("string");
      expect(typeof edge.target).toBe("string");
      expect(edge.source).not.toBe(edge.target);
      expect(edge.edgeId).toBeTruthy();
    }

    // Edges form a chain: first edge source = trigger node
    const triggerNode = wf.nodes.find((n) => n.kind === "trigger");
    const firstEdge = wf.edges[0];
    expect(firstEdge?.source).toBe(triggerNode?.id);
  });

  it("compile() returns a Manifest that parseManifest() accepts", () => {
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
      model: { provider: "bedrock", modelId: "eu.anthropic.claude-haiku-4-5" },
      instructions: "You triage support tickets...",
    });

    // parseManifest must not throw
    expect(() => parseManifest(manifest)).not.toThrow();

    // Top-level fields
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.kind).toBe("workflow");
    expect(manifest.agent.agentId).toBe("support-triage");
    expect(manifest.agent.name).toBe("Support Triage");
    expect(manifest.agent.model.provider).toBe("bedrock");
    expect(manifest.agent.model.modelId).toBe("eu.anthropic.claude-haiku-4-5");
  });

  it("compile() produces a revision string", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      return b.output(c);
    });

    const manifest = wf.compile({ agentId: "test" });
    expect(typeof manifest.revision).toBe("string");
    expect(manifest.revision.length).toBeGreaterThan(0);
    // Revision should be a deterministic hex string (sha256 = 64 chars)
    expect(manifest.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("compile() sets holdsApproval=true when an approval-gated tool is present", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      // createTicketTool has needsApproval: true
      const t2 = b.node(createTicketTool, c, (out) => ({
        subject: out.summary,
        priority: out.severity,
      }));
      return b.output(t2);
    });

    const manifest = wf.compile({ agentId: "approval-test" });
    expect(manifest.resume.holdsApproval).toBe(true);
    expect(manifest.resume.via).toBe("api");
  });

  it("compile() nodes include tool nodes for the two tools", () => {
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

    const manifest = wf.compile({ agentId: "nodes-test" });

    // Two tool nodes (trigger and output are excluded from manifest nodes)
    expect(manifest.nodes).toHaveLength(2);

    const classifyNode = manifest.nodes.find((n) => n.kind === "tool");
    expect(classifyNode).toBeDefined();
  });

  it("compile() records one edge between the two tool nodes", () => {
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

    const manifest = wf.compile({ agentId: "edges-test" });

    // One edge between the two tool nodes
    expect(manifest.edges).toHaveLength(1);
    const edge = manifest.edges[0];
    expect(edge?.edgeId).toBeTruthy();
    expect(edge?.source).toBeTruthy();
    expect(edge?.target).toBeTruthy();
    expect(edge?.source).not.toBe(edge?.target);
  });

  it("compile() params templates reference upstream field paths", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      const t2 = b.node(createTicketTool, c, (out) => ({
        subject: out.summary,     // should become "{{summary}}"
        priority: out.severity,   // should become "{{severity}}"
      }));
      return b.output(t2);
    });

    const manifest = wf.compile({ agentId: "params-test" });

    // Find the createTicket tool node (the second tool node)
    const toolNodes = manifest.nodes.filter((n) => n.kind === "tool");
    expect(toolNodes).toHaveLength(2);

    const createTicketNode = toolNodes[1];
    expect(createTicketNode).toBeDefined();

    if (createTicketNode?.kind === "tool") {
      // params should have template references
      const params = createTicketNode.params;
      expect(params["subject"]).toBe("{{summary}}");
      expect(params["priority"]).toBe("{{severity}}");
    }
  });

  it("compile() outputSchema is derived from zod schema for classify tool", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      return b.output(c);
    });

    const manifest = wf.compile({ agentId: "schema-test" });
    const classifyNode = manifest.nodes[0];
    expect(classifyNode).toBeDefined();

    // outputSchema should have 'summary' and 'severity' fields
    const outputSchema = classifyNode?.outputSchema ?? [];
    expect(outputSchema.length).toBeGreaterThan(0);

    const summaryField = outputSchema.find((f) => f.path === "summary");
    const severityField = outputSchema.find((f) => f.path === "severity");

    expect(summaryField).toBeDefined();
    expect(summaryField?.type).toBe("string");
    expect(summaryField?.isTemplatable).toBe(true);

    expect(severityField).toBeDefined();
    expect(severityField?.type).toBe("string"); // z.enum maps to string
    expect(severityField?.isTemplatable).toBe(true);
  });

  it("compile() includes tools in manifest.tools array with inputSchema", () => {
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

    const manifest = wf.compile({ agentId: "tools-test" });

    expect(manifest.tools).toHaveLength(2);

    for (const tool of manifest.tools) {
      expect(tool.toolId).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.kind).toBe("local");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }

    // createTicketTool has needsApproval: true
    const approvalTool = manifest.tools.find((t) => t.requiresApproval === true);
    expect(approvalTool).toBeDefined();
  });

  it("compile() includes the event trigger in manifest.triggers", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "event",
        eventType: "ticket.created",
        payload: z.object({ body: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.body }));
      return b.output(c);
    });

    const manifest = wf.compile({ agentId: "trigger-test" });

    expect(manifest.triggers).toHaveLength(1);
    const trigger = manifest.triggers[0];
    expect(trigger?.type).toBe("event");
    if (trigger?.type === "event") {
      expect(trigger.eventType).toBe("ticket.created");
    }
  });

  it("compile() produces idempotent revisions for the same workflow", () => {
    const makeWf = () => {
      _resetNodeCounter();
      return defineWorkflow((b) => {
        const t = b.trigger({
          type: "manual",
          payload: z.object({ x: z.string() }),
        });
        const c = b.node(classifyTool, t, (p) => ({ body: p.x }));
        return b.output(c);
      });
    };

    const m1 = makeWf().compile({ agentId: "idempotent" });
    const m2 = makeWf().compile({ agentId: "idempotent" });
    expect(m1.revision).toBe(m2.revision);
  });
});

// ---------------------------------------------------------------------------
// T1 — fan-out brand type safety
// ---------------------------------------------------------------------------

describe("defineWorkflow — FanoutHandle brand safety", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("b.split() returns a FanoutHandle that can be passed to b.fanout()", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ items: z.array(z.string()) }),
      });
      // Transform to get an array
      const arr = b.transform(t, (p) => p.items);
      // Split into individual items
      const fh = b.split(arr);
      // Fanout processes each item
      const processed = b.fanout(fh, (item) =>
        b.transform(item, (s) => s.toUpperCase())
      );
      return b.output(processed);
    });

    // Should record split + fanout nodes
    const nodeKinds = wf.nodes.map((n) => n.kind);
    expect(nodeKinds).toContain("split");
    expect(nodeKinds).toContain("fanout");
  });

  // The following would be a TYPE ERROR at compile time:
  //   const fh = b.split(arr);
  //   b.node(someTool, fh, (x) => x);  // Error: FanoutHandle not assignable to NodeHandle
  //
  // This is verified by the fixtures/miswire suite (separate CI gate).
  // The reason: NodeHandle has `readonly __fanout?: never` (negative brand),
  // so FanoutHandle (with `readonly __fanout: true`) is NOT assignable to NodeHandle.

  it("b.merge() type-checks correctly with A & B output", () => {
    const toolA = defineTool({
      description: "tool a",
      inputSchema: z.object({ x: z.string() }),
      outputSchema: z.object({ alpha: z.string() }),
      execute: async () => ({ alpha: "a" }),
    });

    const toolB = defineTool({
      description: "tool b",
      inputSchema: z.object({ y: z.string() }),
      outputSchema: z.object({ beta: z.number() }),
      execute: async () => ({ beta: 42 }),
    });

    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ x: z.string(), y: z.string() }),
      });
      const a = b.node(toolA, t, (p) => ({ x: p.x }));
      const bNode = b.node(toolB, t, (p) => ({ y: p.y }));
      const m = b.merge(a, bNode);
      // Downstream can read both alpha and beta from the merged handle
      return b.output(m);
    });

    expect(wf.nodes.find((n) => n.kind === "merge")).toBeDefined();
  });

  it("b.transform() infers both Up and Out at one call site", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "manual",
        payload: z.object({ count: z.number() }),
      });
      // Both Up=>{count:number} and Out=>{doubled:number} are inferred here
      const doubled = b.transform(t, (p) => ({ doubled: p.count * 2 }));
      return b.output(doubled);
    });

    expect(wf.nodes.find((n) => n.kind === "transform")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// T1 — compile with agent ref (via AgentRef pattern)
// ---------------------------------------------------------------------------

describe("defineWorkflow — compile with schedule trigger", () => {
  beforeEach(() => {
    _resetNodeCounter();
  });

  it("compile() handles schedule trigger and records cron", () => {
    const wf = defineWorkflow((b) => {
      const t = b.trigger({
        type: "schedule",
        schedule: "daily",
        time: "08:00",
        payload: z.object({ runDate: z.string() }),
      });
      const c = b.node(classifyTool, t, (p) => ({ body: p.runDate }));
      return b.output(c);
    });

    const manifest = wf.compile({ agentId: "scheduled-workflow" });
    expect(() => parseManifest(manifest)).not.toThrow();

    expect(manifest.triggers).toHaveLength(1);
    const trigger = manifest.triggers[0];
    expect(trigger?.type).toBe("schedule");
    if (trigger?.type === "schedule") {
      expect(trigger.cron).toBe("0 8 * * *");
    }
  });
});
