// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest — Zod schema definitions for the draht Manifest.
 *
 * Single source of truth: exports ManifestZ, the inferred Manifest type, and all
 * sub-schemas. Both the SST component (Pulumi-program time) and the Runtime
 * (execution time) import from here — neither hand-rolls a type.
 *
 * Uses the zod v4 codepath (zod/v4) for z.toJSONSchema support.
 * IMPORTANT: import from "zod/v4" not "zod" to get the v4 API.
 */

import { z } from "zod/v4";

export const SCHEMA_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// FieldSchema — recursive full-dot-path tree.
// '[]' marks array-element descent; isTemplatable === false for any path containing '[]'.
// PRODUCED BY THE SAME derive() the typed-graph generics use (hard cross-track contract).
// ---------------------------------------------------------------------------
export type FieldSchema = {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
  isTemplatable: boolean; // false iff path contains '[]'
  fields?: FieldSchema[];
  items?: FieldSchema;
};

// NOTE: The `as unknown as z.ZodType<FieldSchema>` cast is required here because
// zod's `.optional()` marks the property as `T | undefined` at the type level, which
// conflicts with `exactOptionalPropertyTypes: true` where `fields?: FieldSchema[]`
// means "absent or FieldSchema[], but NEVER explicitly undefined". The runtime behaviour
// is correct — the cast is purely a type-level accommodation for the recursive schema.
export const FieldSchemaZ: z.ZodType<FieldSchema> = z.lazy(() =>
  z.object({
    path: z.string(),
    type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
    isTemplatable: z.boolean(),
    fields: z.array(FieldSchemaZ).optional(),
    items: FieldSchemaZ.optional(),
  })
) as unknown as z.ZodType<FieldSchema>;

// ---------------------------------------------------------------------------
// EventFilter
// ---------------------------------------------------------------------------
export const EventFilterZ = z.object({
  field: z.string(),
  operator: z.enum(["eq", "neq", "contains", "regex", "gt", "gte", "lt", "lte"]),
  value: z.string(),
});

// ---------------------------------------------------------------------------
// Trigger — discriminated union; `cron` field is PORTABLE (not aws cron(...) syntax)
// ---------------------------------------------------------------------------
export const TriggerZ = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("schedule"),
    schedule: z.enum(["hourly", "daily", "weekly"]),
    time: z.string().optional(),
    dayOfWeek: z.number().int().min(0).max(6).optional(),
    timezone: z.string().optional(),
    cron: z.string(), // compiler-computed, portable cron expression
  }),
  z.object({
    type: z.literal("event"),
    eventType: z.string(),
    filters: z.array(EventFilterZ).default([]),
  }),
  z.object({
    type: z.literal("webhook"),
    channelRef: z.string(),
  }),
  z.object({
    type: z.literal("manual"),
  }),
]);

// ---------------------------------------------------------------------------
// ToolRef — ONE registry (replaces fr3n's MCP_ACTIONS+STUDIO_TOOLS split)
// ---------------------------------------------------------------------------
export const ToolRefZ = z.object({
  toolId: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(["local", "mcp", "http"]),
  inputSchema: z.object({
    type: z.literal("object"),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).default([]),
  }),
  requiresApproval: z.boolean().default(false),
  dangerous: z.boolean().default(false),
  requiresPermission: z.string().optional(), // REAL RBAC perm (app:view/app:edit) — never app:config:*
  connectionRef: z.string().optional(), // iff kind==='mcp'
});

// ---------------------------------------------------------------------------
// Node — base object .and(discriminatedUnion on "kind": agent|tool|transform|fanout)
// ---------------------------------------------------------------------------
export const NodeZ = z
  .object({
    nodeId: z.string(),
    label: z.string().optional(),
    outputSchema: z.array(FieldSchemaZ), // compiler-computed via shared derive()
  })
  .and(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("agent"),
        agentRef: z.string(),
      }),
      z.object({
        kind: z.literal("tool"),
        toolRef: z.string(),
        requiresApproval: z.boolean().default(false),
        params: z.record(z.string(), z.unknown()).default({}),
      }),
      z.object({
        kind: z.literal("transform"),
        transform: z.discriminatedUnion("type", [
          z.object({
            type: z.literal("map"),
            mappings: z.array(z.object({ from: z.string(), to: z.string() })),
          }),
          z.object({
            type: z.literal("filter"),
            field: z.string(),
            operator: z.string(),
            value: z.string(),
          }),
          z.object({
            type: z.literal("split"),
            arrayField: z.string(),
          }),
          z.object({
            type: z.literal("http_request"),
            method: z.enum(["GET", "POST", "PUT", "DELETE"]),
            url: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
            bodyTemplate: z.string().optional(),
          }),
        ]),
      }),
      z.object({
        kind: z.literal("fanout"),
        elementSubgraph: z.array(z.string()),
        concurrency: z.number().int().default(5),
        /**
         * SHOULD-FIX 4: the elementSubgraph member whose per-item output the
         * executor collects as the fanout's result — i.e. the node the
         * workflow's fanout body function actually RETURNED, which is not
         * necessarily the last-topo-order member. Optional for backward
         * compatibility with manifests compiled before this field existed;
         * the executor falls back to the last-topo-order member when absent.
         */
        terminalSubNodeId: z.string().optional(),
      }),
    ])
  );

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------
export const EdgeZ = z.object({
  edgeId: z.string(),
  source: z.string(),
  target: z.string(),
});

// ---------------------------------------------------------------------------
// SecretRef
// ---------------------------------------------------------------------------
export const SecretRefZ = z.object({
  name: z.string(),
  from: z.enum(["sst-secret", "ssm"]),
  key: z.string(),
});

// ---------------------------------------------------------------------------
// Manifest — the full top-level schema
// ---------------------------------------------------------------------------
export const ManifestZ = z.object({
  // schemaVersion uses z.string() here so that parseManifest can distinguish
  // ManifestVersionError (wrong major) from ManifestValidationError (bad structure).
  // The runtime major-version check lives in parseManifest(), not in the schema itself.
  // The inferred Manifest type still carries schemaVersion as string; callers that need
  // the exact literal can narrow it after parseManifest() succeeds.
  schemaVersion: z.string(), // gates back-compat on load — checked in parseManifest()
  revision: z.string(), // sha256 of CANONICAL body (excl. revision) = resume anchor
  kind: z.enum(["agent", "workflow"]),
  agent: z.object({
    agentId: z.string(),
    name: z.string(),
    model: z.object({
      provider: z.enum(["anthropic", "bedrock"]),
      modelId: z.string(),
      maxOutputTokens: z.number().optional(), // NO temperature on opus-4-8/fable
    }),
    instructionsRef: z.object({
      contentHash: z.string(),
      inline: z.string().optional(),
    }),
    skills: z
      .array(
        z.object({
          id: z.string(),
          description: z.string(),
          contentHash: z.string(),
          inline: z.string().optional(),
        })
      )
      .default([]),
    maxIterations: z.number().int().default(5),
    maxToolCallsPerIteration: z.number().int().default(3),
    circuitBreakerErrorThreshold: z.number().int().default(5),
  }),
  tenancy: z.object({
    mode: z.enum(["single", "multi"]).default("single"),
  }), // seam only in v1
  triggers: z.array(TriggerZ).default([]),
  channels: z
    .array(
      z.object({
        channelId: z.string(),
        kind: z.enum(["http", "slack", "discord"]),
        path: z.string().optional(),
        auth: z.string().optional(),
      })
    )
    .default([]),
  connections: z
    .array(
      z.object({
        connectionRef: z.string(),
        mcpUrl: z.string(),
        authStrategy: z.enum(["none", "bearer", "oauth"]),
      })
    )
    .default([]),
  tools: z.array(ToolRefZ).default([]),
  nodes: z.array(NodeZ).default([]),
  edges: z.array(EdgeZ).default([]),
  resources: z.object({
    needsHttpEgress: z.boolean().default(false),
    needsBedrock: z.boolean().default(false),
    needsEventBus: z.boolean().default(true),
    secrets: z.array(SecretRefZ).default([]),
    extraIam: z
      .array(
        z.object({
          actions: z.array(z.string()),
          resources: z.array(z.string()),
        })
      )
      .default([]),
  }),
  resume: z.object({
    via: z.literal("api"),
    holdsApproval: z.boolean(),
  }),
});

export type Manifest = z.infer<typeof ManifestZ>;
