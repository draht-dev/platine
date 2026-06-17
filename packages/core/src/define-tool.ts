// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/define-tool — typed tool declaration.
 *
 * One declaration → static type (z.infer) + model JSON Schema.
 * Accepts any Standard Schema at the seam (<I extends StandardSchemaV1>),
 * but ships/documents zod because only zod self-emits JSON Schema;
 * non-zod requires an explicit `jsonSchema` override.
 *
 * NOTE: NO temperature/top_p/thinking params on opus-4-8/fable models — use
 * an `effort` enum instead (built in later phases).
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";

// ---------------------------------------------------------------------------
// Schema / Infer helpers
// ---------------------------------------------------------------------------

/** Any StandardSchemaV1-compliant schema (zod satisfies this via `~standard`). */
export type Schema<T = unknown> = StandardSchemaV1<unknown, T>;

/**
 * Extract the OUTPUT type from a StandardSchemaV1 schema.
 * For zod: same as z.infer<S>.
 */
export type Infer<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

// ---------------------------------------------------------------------------
// ToolCtx — execution context injected into every tool call
// ---------------------------------------------------------------------------

/** Execution context passed to `execute`. Extends in later phases (runId, tenantId, etc). */
export interface ToolCtx {
  /** Opaque idempotency key for the current step invocation. */
  readonly idempotencyKey: string;
}

// ---------------------------------------------------------------------------
// ToolDef<I, O> — the typed tool definition record
// ---------------------------------------------------------------------------

/**
 * A fully-typed tool definition produced by `defineTool`.
 *
 * @typeParam I - The input schema type (StandardSchemaV1).
 * @typeParam O - The output schema type (StandardSchemaV1).
 */
export interface ToolDef<I extends Schema, O extends Schema> {
  /** Human-readable description of what this tool does. */
  readonly description: string;
  /** Zod (or other StandardSchemaV1) schema for the tool input. */
  readonly inputSchema: I;
  /** Zod (or other StandardSchemaV1) schema for the tool output. Optional. */
  readonly outputSchema?: O;
  /**
   * Whether this tool requires human approval before execution.
   * May be a static boolean or a predicate that inspects the resolved input.
   */
  readonly needsApproval?: boolean | ((args: Infer<I>) => boolean);
  /**
   * Explicit JSON-Schema override for the input.
   * Required when inputSchema is NOT a zod schema (non-zod validators cannot
   * self-emit JSON Schema, so the compiler would otherwise fail).
   */
  readonly jsonSchema?: Record<string, unknown>;
  /** The async function that executes the tool. */
  readonly execute: (args: Infer<I>, ctx: ToolCtx) => Promise<Infer<O>>;
  /** Internal tag — the compiler uses this to distinguish ToolDef from AgentRef. */
  readonly __kind: "tool";
}

// ---------------------------------------------------------------------------
// defineTool — public factory
// ---------------------------------------------------------------------------

/**
 * Declare a typed tool.
 *
 * The function signature infers both `I` (input schema type) and `O` (output schema
 * type) at the single call site — you never need to annotate generics manually.
 *
 * @example
 * const classify = defineTool({
 *   description: "Classify a support ticket",
 *   inputSchema: z.object({ body: z.string() }),
 *   outputSchema: z.object({ summary: z.string(), severity: z.enum(["low","med","high"]) }),
 *   execute: async ({ body }) => ({ summary: body.slice(0, 80), severity: "high" as const }),
 * });
 */
export function defineTool<I extends Schema, O extends Schema>(d: {
  description: string;
  inputSchema: I;
  outputSchema?: O;
  needsApproval?: boolean | ((args: Infer<I>) => boolean);
  jsonSchema?: Record<string, unknown>;
  execute: (args: Infer<I>, ctx: ToolCtx) => Promise<Infer<O>>;
}): ToolDef<I, O> {
  return { ...d, __kind: "tool" } as ToolDef<I, O>;
}
