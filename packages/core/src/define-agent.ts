// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/define-agent — typed agent declaration.
 *
 * defineAgent: declare an agent with model, instructions, tools, and typed I/O schemas.
 * The builder pattern (defineWorkflow) is in define-workflow.ts.
 *
 * NOTE: NO temperature/top_p/thinking params on opus-4-8/fable models.
 */

import type { Schema, Infer, ToolDef } from "./define-tool.js";

// ---------------------------------------------------------------------------
// AgentDef<I, O> — the typed agent definition record
// ---------------------------------------------------------------------------

/**
 * A fully-typed agent definition produced by `defineAgent`.
 *
 * @typeParam I - The input schema type (StandardSchemaV1). Defaults to Schema.
 * @typeParam O - The output schema type (StandardSchemaV1). Defaults to Schema.
 */
export interface AgentDef<I extends Schema, O extends Schema> {
  /** Model identifier string (e.g. "anthropic/claude-opus-4-5" or "bedrock/..."). */
  readonly model: string;
  /** System instructions for the agent (markdown supported). */
  readonly instructions?: string;
  /** Schema for the agent's input payload. */
  readonly inputSchema?: I;
  /** Schema for the agent's output payload. */
  readonly outputSchema?: O;
  /** Tools available to this agent during its reasoning loop. */
  readonly tools?: ReadonlyArray<ToolDef<Schema, Schema>>;
  /** Maximum number of tool-call iterations before the agent halts. Default: 5. */
  readonly maxIterations?: number;
  /** Maximum tool calls per single iteration. Default: 3. */
  readonly maxToolCallsPerIteration?: number;
  /** Internal tag — the compiler uses this to distinguish AgentDef from ToolDef. */
  readonly __kind: "agent";
}

/**
 * A lightweight reference to an agent, used inside the workflow builder to
 * wire an agent node without embedding the full definition.
 *
 * At runtime, `agentId` resolves to a previously registered AgentDef.
 */
export interface AgentRef<I extends Schema, O extends Schema> {
  readonly agentId: string;
  readonly __agentDef: AgentDef<I, O>;
  readonly __kind: "agentRef";
}

// ---------------------------------------------------------------------------
// defineAgent — public factory
// ---------------------------------------------------------------------------

/**
 * Declare a typed agent.
 *
 * @example
 * const triageAgent = defineAgent({
 *   model: "anthropic/claude-haiku-4-5",
 *   instructions: "You triage support tickets...",
 *   inputSchema: z.object({ body: z.string() }),
 *   outputSchema: z.object({ summary: z.string(), severity: z.enum(["low","med","high"]) }),
 *   tools: [lookupHistoryTool],
 *   maxIterations: 5,
 * });
 */
export function defineAgent<I extends Schema, O extends Schema>(d: {
  model: string;
  instructions?: string;
  inputSchema?: I;
  outputSchema?: O;
  tools?: ReadonlyArray<ToolDef<Schema, Schema>>;
  maxIterations?: number;
  maxToolCallsPerIteration?: number;
}): AgentDef<I, O> {
  return { ...d, __kind: "agent" } as AgentDef<I, O>;
}
