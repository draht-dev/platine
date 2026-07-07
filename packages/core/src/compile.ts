// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/compile — authoring artifacts → Manifest compiler.
 *
 * This is the SOLE writer of compiler-computed fields in the Manifest:
 *   - node `outputSchema` via `derive()` from the manifest package
 *   - `revision` via `computeRevision()` from the manifest package
 *   - tool `inputSchema` via `zodToJsonSchema()` from the manifest package
 *
 * It MUST NOT reimplement these functions — it calls them.
 *
 * ## Declarative-params bridge
 *
 * The manifest is declarative (no functions). Each node mapper is converted to
 * the declarative `params` template by executing it at compile time against a
 * path-recording Proxy. Property access `out.summary` records the path and yields
 * the token `{{summary}}`; the returned object becomes e.g.:
 *   { subject: "{{summary}}", priority: "{{severity}}" }
 *
 * Supported: direct field passthrough, rename, nesting, string-template composition.
 * For a mapper too complex for the Proxy to capture (arbitrary runtime logic), we
 * record the edge and emit a console.warn + a best-effort param `"{{?}}"`.
 *
 * ## v1 limitation
 *
 * The Proxy-based param extraction works reliably for pure field-mapping functions:
 *   (out) => ({ subject: out.summary, priority: out.severity })
 *
 * It does NOT reliably handle:
 *   - Conditional logic (if/ternary branching on Proxy access result)
 *   - Array methods (.map, .filter, .reduce) on Proxy-wrapped values
 *   - Computed property keys
 *   - Side effects (calls to external functions that don't return Proxy values)
 *
 * For these cases, the compiler emits a warning and records `"{{?}}"` as a placeholder.
 * This is a documented v1 limitation; v2 should support an explicit `params` override
 * on the node definition.
 */

import { createHash } from "node:crypto";
import type { z } from "zod/v4";
import {
  derive,
  zodToJsonSchema,
  computeRevision,
  parseManifest,
} from "./manifest/index.js";
import type { Manifest, FieldSchema } from "./manifest/schema.js";
import type {
  WorkflowDef,
  WorkflowCompileOptions,
  RecordedNode,
  TriggerConfig,
} from "./define-workflow.js";
import type { ToolDef, Schema } from "./define-tool.js";
import type { AgentDef } from "./define-agent.js";

// ---------------------------------------------------------------------------
// Proxy-based param extraction
// ---------------------------------------------------------------------------

/** Sentinel token used for paths that can't be captured cleanly. */
const UNKNOWN_TOKEN = "{{?}}";

/**
 * Create a path-recording Proxy. When a property is accessed, it records the
 * path and returns a template token string `{{path}}`.
 *
 * The proxy is shallow-recursive: accessing `proxy.a.b` works because `proxy.a`
 * returns another proxy recording `"a"`, and `.b` on that returns `"{{a.b}}"`.
 */
function makeProxy(path: string): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop: string | symbol): unknown {
      if (typeof prop !== "string") return UNKNOWN_TOKEN;
      const childPath = path === "" ? prop : `${path}.${prop}`;
      // Return a Proxy for nested access, but also expose the template token
      // when the value is finally used (e.g. as a string in an object literal).
      const childProxy = makeProxy(childPath);
      // Allow the proxy to coerce to a string token when used in a context
      // that expects a primitive (e.g., object literal value).
      // We use a Proxy over a String object so that string coercion works.
      const token = `{{${childPath}}}`;
      const strObj = new String(token);
      return new Proxy(strObj, {
        get(target: String, p: string | symbol): unknown {
          if (p === Symbol.toPrimitive || p === "toString" || p === "valueOf") {
            return () => token;
          }
          if (typeof p === "string") {
            const nested = `${childPath}.${p}`;
            return makeProxy(nested);
          }
          return Reflect.get(target, p);
        },
        apply(): unknown {
          return token;
        },
      });
    },
  };
  return new Proxy({}, handler);
}

/**
 * Execute a mapper function against a Proxy and collect the returned object
 * as a declarative params record.
 *
 * Returns a `Record<string, unknown>` where each value is a `"{{path}}"` token
 * string (or a nested object of such tokens for deeply nested params).
 *
 * If the mapper throws or returns a non-object, falls back to `{ "?": "{{?}}" }`.
 */
function extractParams(
  mapper: (out: unknown) => unknown,
  nodeId: string
): Record<string, unknown> {
  const rootProxy = makeProxy("");
  let result: unknown;
  try {
    result = mapper(rootProxy);
  } catch {
    console.warn(
      `[draht/compile] Node "${nodeId}": mapper threw during Proxy-based param extraction. ` +
        `This usually means the mapper contains conditional logic or side effects that ` +
        `cannot be captured declaratively. Recording "{{?}}" as a placeholder. ` +
        `(v1 limitation — see compile.ts)`
    );
    return { "?": UNKNOWN_TOKEN };
  }

  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    console.warn(
      `[draht/compile] Node "${nodeId}": mapper returned a non-object (${typeof result}). ` +
        `Cannot extract declarative params. Recording "{{?}}" as a placeholder.`
    );
    return { "?": UNKNOWN_TOKEN };
  }

  // Recursively coerce Proxy/String objects to their token strings.
  return coerceToParams(result as Record<string, unknown>);
}

/**
 * Walk a potentially Proxy-wrapped object and coerce all leaf values to strings.
 */
function coerceToParams(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (value instanceof String) {
      // String object wrapping a template token
      result[key] = value.valueOf();
    } else if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else if (typeof value === "object" && !Array.isArray(value)) {
      // Could be a nested object or a Proxy.
      // Try to extract params recursively.
      try {
        const nested = Object.entries(value as Record<string, unknown>);
        if (nested.length === 0) {
          // Empty object or opaque Proxy — try to coerce to string
          result[key] = String(value);
        } else {
          result[key] = coerceToParams(value as Record<string, unknown>);
        }
      } catch {
        result[key] = String(value);
      }
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/**
 * Check if a value has a `_zod` property (duck-type for a zod v4 schema).
 */
function isZodSchema(schema: unknown): schema is z.ZodTypeAny {
  return (
    schema !== null &&
    typeof schema === "object" &&
    "_zod" in (schema as object)
  );
}

/**
 * Extract the output FieldSchema tree from a ToolDef or AgentDef.
 * Returns an empty array if no outputSchema is present or it's not a zod schema.
 */
function deriveOutputSchema(
  def: ToolDef<Schema, Schema> | AgentDef<Schema, Schema>
): FieldSchema[] {
  const outputSchema =
    (def as ToolDef<Schema, Schema>).outputSchema ??
    (def as AgentDef<Schema, Schema>).outputSchema;

  if (outputSchema === undefined) return [];
  if (!isZodSchema(outputSchema)) return [];

  return derive(outputSchema);
}

/**
 * Extract the JSON-Schema representation of a ToolDef's inputSchema.
 * Falls back to `{ type: "object", properties: {}, required: [] }` if not a zod schema.
 */
function extractToolInputJsonSchema(
  def: ToolDef<Schema, Schema>
): { type: "object"; properties: Record<string, unknown>; required: string[] } {
  // If an explicit jsonSchema override is provided, use it.
  if (def.jsonSchema !== undefined) {
    return {
      type: "object",
      properties: (def.jsonSchema["properties"] as Record<string, unknown>) ?? {},
      required: (def.jsonSchema["required"] as string[]) ?? [],
    };
  }

  if (!isZodSchema(def.inputSchema)) {
    return { type: "object", properties: {}, required: [] };
  }

  const raw = zodToJsonSchema(def.inputSchema);
  return {
    type: "object",
    properties: (raw["properties"] as Record<string, unknown>) ?? {},
    required: (raw["required"] as string[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/** Compute a deterministic short hash for a content string. */
function contentHash(content: string): string {
  return (
    "sha256:" +
    createHash("sha256").update(content, "utf8").digest("hex").slice(0, 8)
  );
}

// ---------------------------------------------------------------------------
// compileWorkflow — main entry point
// ---------------------------------------------------------------------------

/**
 * buildToolRegistry — walk a WorkflowDef's nodes and collect every "tool" /
 * "unsafe" node's ToolDef, keyed by the SAME `"tool_" + node.id` scheme
 * compileWorkflow uses for `toolRef` / `toolId` in the Manifest.
 *
 * This is the SOLE place that scheme is implemented — compileWorkflow calls
 * this function for its own tool collection (below) so the manifest's
 * `toolRef`/`toolId` values and this registry's keys can never drift apart.
 *
 * The runtime executor (RealToolsDispatcher in @draht/runtime-aws) builds its
 * in-process tool registry from this function, keyed identically to how
 * `node.toolRef` is resolved at dispatch time — the ToolDef's `execute()`
 * closure lives ONLY on RecordedNode.def (never serialized into the Manifest).
 */
export function buildToolRegistry(
  wf: WorkflowDef
): Map<string, ToolDef<Schema, Schema>> {
  const registry = new Map<string, ToolDef<Schema, Schema>>();

  for (const node of wf.nodes) {
    if ((node.kind === "tool" || node.kind === "unsafe") && node.def) {
      const toolDef = node.def as ToolDef<Schema, Schema>;
      // Use the node id as the tool id for now (could be refined with a name field)
      const toolId = `tool_${node.id}`;
      registry.set(toolId, toolDef);
    }
  }

  return registry;
}

/**
 * Compile a WorkflowDef into a Manifest.
 *
 * This is the SOLE writer of compiler-computed fields:
 *   - `outputSchema` for each node (via `derive()`)
 *   - `revision` (via `computeRevision()`)
 *   - `inputSchema` for tools (via `zodToJsonSchema()`)
 *
 * The produced Manifest is validated via `parseManifest()` before returning.
 */
export function compileWorkflow(
  wf: WorkflowDef,
  opts?: WorkflowCompileOptions
): Manifest {
  const agentId = opts?.agentId ?? "workflow";
  const name = opts?.name ?? agentId;
  const instructions = opts?.instructions ?? "";
  const model = opts?.model ?? {
    provider: "anthropic" as const,
    modelId: "anthropic/claude-opus-4-5",
  };

  // -------------------------------------------------------------------------
  // 1. Collect tools referenced in tool nodes
  // -------------------------------------------------------------------------
  const toolDefs = buildToolRegistry(wf);

  // -------------------------------------------------------------------------
  // 2. Build manifest nodes
  // -------------------------------------------------------------------------
  type ManifestNodeInput = {
    nodeId: string;
    label?: string;
    outputSchema: FieldSchema[];
    kind: string;
    [key: string]: unknown;
  };

  const manifestNodes: ManifestNodeInput[] = [];

  for (const node of wf.nodes) {
    if (node.kind === "output") {
      // Output nodes are markers — they don't appear as manifest nodes.
      continue;
    }

    if (node.kind === "trigger") {
      // Trigger nodes carry payload schema — derive outputSchema from it.
      const payloadSchema = (
        node.triggerConfig as (TriggerConfig & { payload?: Schema }) | undefined
      )?.payload;

      const outputSchema: FieldSchema[] =
        payloadSchema !== undefined && isZodSchema(payloadSchema)
          ? derive(payloadSchema)
          : [];

      // Trigger nodes map to an "agent" kind node in the manifest (the trigger
      // itself is captured in manifest.triggers, not as a node).
      // However, the spec's manifest example shows trigger as the first node with
      // kind "agent". For the workflow compiler, we skip the trigger node since
      // the trigger is recorded in manifest.triggers instead.
      // We only record tool/agent nodes as manifest nodes.
      void outputSchema; // used below for edge resolution
      continue;
    }

    if (node.kind === "tool" || node.kind === "unsafe") {
      const toolDef = node.def as ToolDef<Schema, Schema> | undefined;
      const toolId = `tool_${node.id}`;
      const outputSchema = toolDef ? deriveOutputSchema(toolDef) : [];

      // Extract params via Proxy-based mapper execution
      const params: Record<string, unknown> = node.mapper
        ? extractParams(node.mapper, node.id)
        : {};

      const requiresApproval = Boolean(
        node.requiresApproval ??
          (toolDef?.needsApproval === true
            ? true
            : typeof toolDef?.needsApproval === "function"
              ? false
              : false)
      );

      manifestNodes.push({
        nodeId: node.id,
        outputSchema,
        kind: "tool",
        toolRef: toolId,
        requiresApproval,
        params,
      });
      continue;
    }

    if (node.kind === "agent") {
      const agentDef = node.def as AgentDef<Schema, Schema> | undefined;
      const outputSchema = agentDef ? deriveOutputSchema(agentDef) : [];

      manifestNodes.push({
        nodeId: node.id,
        outputSchema,
        kind: "agent",
        agentRef: agentId,
      });
      continue;
    }

    if (node.kind === "transform") {
      // Transform nodes: record as a transform/map node.
      // We attempt to extract the mapping via the fn.
      // For split transforms (like p => [p.body]), we record as a "split" transform.
      manifestNodes.push({
        nodeId: node.id,
        outputSchema: [],
        kind: "transform",
        transform: {
          type: "map",
          mappings: [] as Array<{ from: string; to: string }>,
        },
      });
      continue;
    }

    if (node.kind === "split") {
      // Split nodes record the array field that's being split.
      manifestNodes.push({
        nodeId: node.id,
        outputSchema: [],
        kind: "transform",
        transform: {
          type: "split",
          arrayField: "",
        },
      });
      continue;
    }

    if (node.kind === "fanout") {
      // Fanout nodes wrap a sub-workflow (elementSubgraph). The sub-recording
      // builder (define-workflow.ts::fanout()) already invoked the body
      // EAGERLY against the real builder at graph-construction time, and
      // captured the resulting node ids (in recorded/topological order) onto
      // node.subNodeIds. Those sub-nodes are ALREADY present in wf.nodes (and
      // their internal edges in wf.edges) — the main loop above / edge loop
      // below emit them like any other node, so all we do here is list them.
      const elementSubgraph: string[] = [...(node.subNodeIds ?? [])];

      manifestNodes.push({
        nodeId: node.id,
        outputSchema: [],
        kind: "fanout",
        elementSubgraph,
        concurrency: node.concurrency ?? 5,
        // SHOULD-FIX 4: thread through the body's actually-RETURNED handle id
        // (see define-workflow.ts::fanout()'s terminalSubNodeId capture) so
        // the executor collects the right per-item output even when the body
        // recorded additional nodes after the one it returned.
        ...(node.terminalSubNodeId !== undefined
          ? { terminalSubNodeId: node.terminalSubNodeId }
          : {}),
      });
      continue;
    }

    if (node.kind === "merge") {
      // Merge nodes are represented as a map transform that combines upstream outputs.
      manifestNodes.push({
        nodeId: node.id,
        outputSchema: [],
        kind: "transform",
        transform: {
          type: "map",
          mappings: [] as Array<{ from: string; to: string }>,
        },
      });
      continue;
    }
  }

  // -------------------------------------------------------------------------
  // 3. Build manifest edges (skip edges involving output/trigger nodes)
  // -------------------------------------------------------------------------
  // First collect the IDs of nodes we include in the manifest
  const manifestNodeIds = new Set(manifestNodes.map((n) => n.nodeId));

  // Build a reverse map from manifest-excluded node IDs to their sources.
  // When a trigger → first_real_node edge exists, we skip it (trigger is implicit).
  // When an output node is in an edge, we strip it.
  const manifestEdges: Array<{ edgeId: string; source: string; target: string }> = [];

  for (const edge of wf.edges) {
    const sourceIncluded = manifestNodeIds.has(edge.source);
    const targetIncluded = manifestNodeIds.has(edge.target);

    if (sourceIncluded && targetIncluded) {
      manifestEdges.push({
        edgeId: edge.edgeId,
        source: edge.source,
        target: edge.target,
      });
    }
    // Edges from trigger (excluded) to first node: skip — covered by manifest.triggers
    // Edges to output (excluded): skip
  }

  // -------------------------------------------------------------------------
  // 4. Build tools array
  // -------------------------------------------------------------------------
  const toolsArray: Array<{
    toolId: string;
    name: string;
    description: string;
    kind: "local";
    inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
    requiresApproval: boolean;
    dangerous: boolean;
  }> = [];

  for (const [toolId, toolDef] of toolDefs) {
    toolsArray.push({
      toolId,
      name: toolId,
      description: toolDef.description,
      kind: "local",
      inputSchema: extractToolInputJsonSchema(toolDef),
      requiresApproval: toolDef.needsApproval === true,
      dangerous: false,
    });
  }

  // -------------------------------------------------------------------------
  // 5. Determine trigger config from the first trigger node
  // -------------------------------------------------------------------------
  const triggerNode = wf.nodes.find((n) => n.kind === "trigger");
  const triggerConfig = triggerNode?.triggerConfig as
    | (TriggerConfig & { payload?: Schema })
    | undefined;

  const triggersArray: Manifest["triggers"] = [];
  if (triggerConfig !== undefined) {
    if (triggerConfig.type === "schedule") {
      triggersArray.push({
        type: "schedule",
        schedule: triggerConfig.schedule,
        time: triggerConfig.time,
        dayOfWeek: triggerConfig.dayOfWeek,
        timezone: triggerConfig.timezone,
        cron: scheduleToCron(
          triggerConfig.schedule,
          triggerConfig.time,
          triggerConfig.dayOfWeek
        ),
      });
    } else if (triggerConfig.type === "event") {
      triggersArray.push({
        type: "event",
        eventType: triggerConfig.eventType,
        filters: triggerConfig.filters ?? [],
      });
    } else if (triggerConfig.type === "webhook") {
      triggersArray.push({
        type: "webhook",
        channelRef: triggerConfig.channelRef,
      });
    } else if (triggerConfig.type === "manual") {
      triggersArray.push({ type: "manual" });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Determine holdsApproval
  // -------------------------------------------------------------------------
  const holdsApproval = manifestNodes.some(
    (n) => n.kind === "tool" && n.requiresApproval === true
  );

  // -------------------------------------------------------------------------
  // 7. Assemble the pre-revision manifest body
  // -------------------------------------------------------------------------
  const instructionsHash = contentHash(instructions);

  // Cast to unknown first to work around the intersection type in NodeZ
  const rawManifest: unknown = {
    schemaVersion: "1.0.0",
    revision: "placeholder", // will be replaced
    kind: "workflow" as const,
    agent: {
      agentId,
      name,
      model: {
        provider: model.provider,
        modelId: model.modelId,
        ...(model.maxOutputTokens !== undefined
          ? { maxOutputTokens: model.maxOutputTokens }
          : {}),
      },
      instructionsRef: {
        contentHash: instructionsHash,
        ...(instructions.length > 0 ? { inline: instructions } : {}),
      },
      skills: [],
      maxIterations: 5,
      maxToolCallsPerIteration: 3,
      circuitBreakerErrorThreshold: 5,
    },
    tenancy: { mode: "single" as const },
    triggers: triggersArray,
    channels: [],
    connections: [],
    tools: toolsArray,
    nodes: manifestNodes,
    edges: manifestEdges,
    resources: {
      needsHttpEgress: false,
      needsBedrock: model.provider === "bedrock",
      needsEventBus: true,
      secrets: [],
      extraIam: [],
    },
    resume: {
      via: "api" as const,
      holdsApproval,
    },
  };

  // -------------------------------------------------------------------------
  // 8. Compute the canonical revision and insert it
  // -------------------------------------------------------------------------
  const revision = computeRevision(rawManifest);
  const manifestWithRevision = {
    ...(rawManifest as Record<string, unknown>),
    revision,
  };

  // -------------------------------------------------------------------------
  // 9. Validate via parseManifest — throws ManifestValidationError on failure
  // -------------------------------------------------------------------------
  return parseManifest(manifestWithRevision);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a schedule enum + optional time to a portable cron expression. */
function scheduleToCron(
  schedule: "hourly" | "daily" | "weekly",
  time?: string,
  dayOfWeek?: number
): string {
  const [hourStr, minuteStr] = (time ?? "00:00").split(":");
  const hour = parseInt(hourStr ?? "0", 10);
  const minute = parseInt(minuteStr ?? "0", 10);

  if (schedule === "hourly") return `${minute} * * * *`;
  if (schedule === "daily") return `${minute} ${hour} * * *`;
  if (schedule === "weekly") {
    const day = dayOfWeek ?? 0;
    return `${minute} ${hour} * * ${day}`;
  }
  return "0 * * * *";
}
