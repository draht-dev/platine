// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for @draht/core/manifest.
 *
 * Covers:
 * - parseManifest: the §3.1 support-triage example manifest round-trips correctly
 * - parseManifest: schemaVersion "2.0.0" throws ManifestVersionError
 * - parseManifest: missing required field throws ManifestValidationError
 * - computeRevision: stable under key reordering; changes when a value changes; excludes `revision`
 * - derive(): nested object → correct dotted paths
 * - derive(): array-of-objects → "field[].sub" paths with isTemplatable=false
 * - derive(): optional/default unwrap
 */

import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import {
  parseManifest,
  computeRevision,
  ManifestValidationError,
  ManifestVersionError,
  derive,
} from "./index.js";

// ---------------------------------------------------------------------------
// §3.1 support-triage example manifest (verbatim from the spec, normalized)
// ---------------------------------------------------------------------------
const supportTriageManifest = {
  schemaVersion: "1.0.0",
  revision: "rev_a3f91c08b7",
  kind: "workflow",
  agent: {
    agentId: "support-triage",
    name: "Support Triage",
    model: { provider: "bedrock", modelId: "eu.anthropic.claude-haiku-4-5" },
    instructionsRef: {
      contentHash: "sha256:9f2a",
      inline: "You triage support tickets...",
    },
    maxIterations: 5,
    maxToolCallsPerIteration: 3,
    circuitBreakerErrorThreshold: 5,
  },
  tenancy: { mode: "single" },
  triggers: [
    {
      type: "event",
      eventType: "ticket.created",
      filters: [{ field: "priority", operator: "eq", value: "high" }],
    },
  ],
  channels: [
    { channelId: "http-in", kind: "http", path: "/v1/triage", auth: "bearer" },
  ],
  tools: [
    {
      toolId: "escalate_ticket",
      name: "Escalate Ticket",
      description: "Escalate to human queue",
      kind: "local",
      requiresApproval: true,
      dangerous: true,
      requiresPermission: "app:edit",
      inputSchema: {
        type: "object",
        properties: {
          ticketId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["ticketId", "reason"],
      },
    },
  ],
  nodes: [
    {
      nodeId: "classify",
      kind: "agent",
      agentRef: "support-triage",
      outputSchema: [
        { path: "classification", type: "string", isTemplatable: true },
        { path: "ticketId", type: "string", isTemplatable: true },
      ],
    },
    {
      nodeId: "escalate",
      kind: "tool",
      toolRef: "escalate_ticket",
      requiresApproval: true,
      params: {
        ticketId: "{{ticketId}}",
        reason: "{{classification}}",
      },
      outputSchema: [
        { path: "queued", type: "boolean", isTemplatable: true },
      ],
    },
  ],
  edges: [{ edgeId: "e1", source: "classify", target: "escalate" }],
  resources: {
    needsBedrock: true,
    needsEventBus: true,
    secrets: [
      {
        name: "ESCALATION_API_KEY",
        from: "sst-secret",
        key: "EscalationApiKey",
      },
    ],
  },
  resume: { via: "api", holdsApproval: true },
} as const;

// ---------------------------------------------------------------------------
// parseManifest tests
// ---------------------------------------------------------------------------

describe("parseManifest", () => {
  it("parses the §3.1 support-triage example manifest successfully", () => {
    const manifest = parseManifest(supportTriageManifest);

    // Top-level fields
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.kind).toBe("workflow");
    expect(manifest.revision).toBe("rev_a3f91c08b7");

    // Agent
    expect(manifest.agent.agentId).toBe("support-triage");
    expect(manifest.agent.name).toBe("Support Triage");
    expect(manifest.agent.model.provider).toBe("bedrock");
    expect(manifest.agent.model.modelId).toBe("eu.anthropic.claude-haiku-4-5");
    expect(manifest.agent.maxIterations).toBe(5);

    // Tenancy
    expect(manifest.tenancy.mode).toBe("single");

    // Triggers
    expect(manifest.triggers).toHaveLength(1);
    const trigger = manifest.triggers[0];
    expect(trigger).toBeDefined();
    if (trigger?.type === "event") {
      expect(trigger.eventType).toBe("ticket.created");
      expect(trigger.filters).toHaveLength(1);
      const filter = trigger.filters[0];
      expect(filter?.operator).toBe("eq");
    }

    // Tools
    expect(manifest.tools).toHaveLength(1);
    const tool = manifest.tools[0];
    expect(tool?.toolId).toBe("escalate_ticket");
    expect(tool?.requiresApproval).toBe(true);
    expect(tool?.dangerous).toBe(true);
    expect(tool?.requiresPermission).toBe("app:edit");

    // Nodes
    expect(manifest.nodes).toHaveLength(2);
    const classifyNode = manifest.nodes[0];
    expect(classifyNode?.nodeId).toBe("classify");
    if (classifyNode?.kind === "agent") {
      expect(classifyNode.agentRef).toBe("support-triage");
    }

    // Edges
    expect(manifest.edges).toHaveLength(1);
    expect(manifest.edges[0]?.edgeId).toBe("e1");

    // Resources
    expect(manifest.resources.needsBedrock).toBe(true);
    expect(manifest.resources.secrets).toHaveLength(1);

    // Resume
    expect(manifest.resume.via).toBe("api");
    expect(manifest.resume.holdsApproval).toBe(true);
  });

  it("fills in default values for omitted optional fields", () => {
    const manifest = parseManifest(supportTriageManifest);
    // skills defaults to []
    expect(manifest.agent.skills).toEqual([]);
    // connections defaults to []
    expect(manifest.connections).toEqual([]);
    // resources.needsHttpEgress defaults to false
    expect(manifest.resources.needsHttpEgress).toBe(false);
    // resources.extraIam defaults to []
    expect(manifest.resources.extraIam).toEqual([]);
  });

  it("throws ManifestVersionError when schemaVersion major is 2.x.x", () => {
    const badManifest = {
      ...supportTriageManifest,
      // Override schemaVersion to "2.0.0" - can't use literal validator here
      // so we force a non-literal parse via unknown cast
    };
    // We need to bypass the literal validator — pass as unknown
    const raw: unknown = { ...badManifest, schemaVersion: "2.0.0" };
    expect(() => parseManifest(raw)).toThrow(ManifestVersionError);
  });

  it("throws ManifestValidationError when schemaVersion is missing", () => {
    const { schemaVersion: _, ...withoutVersion } = supportTriageManifest as {
      schemaVersion: string;
      [key: string]: unknown;
    };
    expect(() => parseManifest(withoutVersion)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError when agent.agentId is missing", () => {
    const raw: unknown = {
      ...supportTriageManifest,
      agent: {
        // missing agentId
        name: "Support Triage",
        model: supportTriageManifest.agent.model,
        instructionsRef: supportTriageManifest.agent.instructionsRef,
      },
    };
    expect(() => parseManifest(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError when kind is invalid", () => {
    const raw: unknown = { ...supportTriageManifest, kind: "invalid_kind" };
    expect(() => parseManifest(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError when resume is missing", () => {
    const { resume: _, ...withoutResume } = supportTriageManifest as {
      resume: unknown;
      [key: string]: unknown;
    };
    expect(() => parseManifest(withoutResume)).toThrow(ManifestValidationError);
  });

  it("throws ManifestVersionError with a descriptive message", () => {
    const raw: unknown = { ...supportTriageManifest, schemaVersion: "2.0.0" };
    try {
      parseManifest(raw);
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestVersionError);
      expect((e as Error).message).toContain("2.0.0");
      expect((e as Error).message).toContain("1.0.0");
    }
  });
});

// ---------------------------------------------------------------------------
// computeRevision tests
// ---------------------------------------------------------------------------

describe("computeRevision", () => {
  const baseBody = {
    schemaVersion: "1.0.0",
    revision: "old_revision_should_be_excluded",
    kind: "workflow",
    agent: {
      agentId: "test-agent",
      name: "Test Agent",
    },
  };

  it("is stable: same object produces the same revision", () => {
    const r1 = computeRevision(baseBody);
    const r2 = computeRevision(baseBody);
    expect(r1).toBe(r2);
  });

  it("is stable under key reordering: different key order produces same revision", () => {
    const body1 = { a: "hello", b: "world", c: 42 };
    const body2 = { c: 42, a: "hello", b: "world" };
    // Different key order, same values
    expect(computeRevision(body1)).toBe(computeRevision(body2));
  });

  it("is stable under nested key reordering", () => {
    const body1 = {
      schemaVersion: "1.0.0",
      agent: { agentId: "a", name: "b" },
    };
    const body2 = {
      agent: { name: "b", agentId: "a" },
      schemaVersion: "1.0.0",
    };
    expect(computeRevision(body1)).toBe(computeRevision(body2));
  });

  it("changes when a value changes", () => {
    const body1 = { schemaVersion: "1.0.0", kind: "agent" };
    const body2 = { schemaVersion: "1.0.0", kind: "workflow" };
    expect(computeRevision(body1)).not.toBe(computeRevision(body2));
  });

  it("excludes the `revision` field from the hash", () => {
    const withRev1 = { ...baseBody, revision: "revision_abc" };
    const withRev2 = { ...baseBody, revision: "revision_xyz" };
    // Same content except revision — should produce same hash
    expect(computeRevision(withRev1)).toBe(computeRevision(withRev2));
  });

  it("produces a 64-character hex string (sha256)", () => {
    const rev = computeRevision(baseBody);
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// derive() tests
// ---------------------------------------------------------------------------

describe("derive()", () => {
  it("derives dotted paths from a nested object schema", () => {
    const schema = z.object({
      ticket: z.object({
        id: z.string(),
        count: z.number(),
      }),
      label: z.string(),
    });

    const fields = derive(schema);

    // Top-level keys
    const ticketField = fields.find((f) => f.path === "ticket");
    const labelField = fields.find((f) => f.path === "label");

    expect(ticketField).toBeDefined();
    expect(ticketField?.type).toBe("object");
    expect(ticketField?.isTemplatable).toBe(true);

    expect(labelField).toBeDefined();
    expect(labelField?.type).toBe("string");
    expect(labelField?.isTemplatable).toBe(true);

    // Nested fields inside ticket
    const ticketFields = ticketField?.fields ?? [];
    const idField = ticketFields.find((f) => f.path === "ticket.id");
    const countField = ticketFields.find((f) => f.path === "ticket.count");

    expect(idField).toBeDefined();
    expect(idField?.type).toBe("string");
    expect(idField?.isTemplatable).toBe(true);

    expect(countField).toBeDefined();
    expect(countField?.type).toBe("number");
    expect(countField?.isTemplatable).toBe(true);
  });

  it("produces field[].sub paths with isTemplatable=false for array-of-objects", () => {
    const schema = z.object({
      items: z.array(
        z.object({
          name: z.string(),
          count: z.number(),
        })
      ),
    });

    const fields = derive(schema);

    // Top-level items field
    const itemsField = fields.find((f) => f.path === "items");
    expect(itemsField).toBeDefined();
    expect(itemsField?.type).toBe("array");
    expect(itemsField?.isTemplatable).toBe(true); // items itself is templatable

    // items has an `items` property (the element schema)
    const itemSchema = itemsField?.items;
    expect(itemSchema).toBeDefined();
    expect(itemSchema?.path).toBe("items[]");
    expect(itemSchema?.type).toBe("object");
    expect(itemSchema?.isTemplatable).toBe(false); // '[]' in path → not templatable

    // Nested fields inside items[]
    const itemFields = itemSchema?.fields ?? [];
    const nameField = itemFields.find((f) => f.path === "items[].name");
    const countField = itemFields.find((f) => f.path === "items[].count");

    expect(nameField).toBeDefined();
    expect(nameField?.type).toBe("string");
    expect(nameField?.isTemplatable).toBe(false); // ancestor has '[]'

    expect(countField).toBeDefined();
    expect(countField?.type).toBe("number");
    expect(countField?.isTemplatable).toBe(false);
  });

  it("unwraps optional fields correctly", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });

    const fields = derive(schema);

    const reqField = fields.find((f) => f.path === "required");
    const optField = fields.find((f) => f.path === "optional");

    expect(reqField?.type).toBe("string");
    expect(optField?.type).toBe("string"); // unwrapped from optional
    expect(optField?.isTemplatable).toBe(true);
  });

  it("unwraps default() wrappers correctly", () => {
    const schema = z.object({
      name: z.string().default("unnamed"),
      count: z.number().default(0),
    });

    const fields = derive(schema);

    const nameField = fields.find((f) => f.path === "name");
    const countField = fields.find((f) => f.path === "count");

    expect(nameField?.type).toBe("string");
    expect(countField?.type).toBe("number");
  });

  it("treats z.enum as string type", () => {
    const schema = z.object({
      status: z.enum(["pending", "active", "done"]),
    });

    const fields = derive(schema);
    const statusField = fields.find((f) => f.path === "status");

    expect(statusField?.type).toBe("string");
    expect(statusField?.isTemplatable).toBe(true);
  });

  it("produces boolean type for z.boolean()", () => {
    const schema = z.object({
      active: z.boolean(),
    });

    const fields = derive(schema);
    const activeField = fields.find((f) => f.path === "active");

    expect(activeField?.type).toBe("boolean");
  });

  it("produces 'unknown' for non-standard types", () => {
    const schema = z.object({
      data: z.any(),
    });

    const fields = derive(schema);
    const dataField = fields.find((f) => f.path === "data");

    expect(dataField?.type).toBe("unknown");
  });

  it("handles deeply nested objects with correct paths", () => {
    const schema = z.object({
      a: z.object({
        b: z.object({
          c: z.string(),
        }),
      }),
    });

    const fields = derive(schema);

    // Top-level
    const aField = fields.find((f) => f.path === "a");
    expect(aField?.type).toBe("object");

    // One level deep
    const bField = aField?.fields?.find((f) => f.path === "a.b");
    expect(bField?.type).toBe("object");

    // Two levels deep
    const cField = bField?.fields?.find((f) => f.path === "a.b.c");
    expect(cField?.type).toBe("string");
    expect(cField?.isTemplatable).toBe(true);
  });

  it("handles array of primitives", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const fields = derive(schema);
    const tagsField = fields.find((f) => f.path === "tags");

    expect(tagsField?.type).toBe("array");
    expect(tagsField?.items?.path).toBe("tags[]");
    expect(tagsField?.items?.type).toBe("string");
    expect(tagsField?.items?.isTemplatable).toBe(false);
  });

  it("handles intersections (.and()) by merging shapes", () => {
    const base = z.object({ id: z.string() });
    const extra = z.object({ name: z.string() });
    const schema = base.and(extra);

    const fields = derive(schema);

    const idField = fields.find((f) => f.path === "id");
    const nameField = fields.find((f) => f.path === "name");

    expect(idField?.type).toBe("string");
    expect(nameField?.type).toBe("string");
  });
});
