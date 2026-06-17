// SPDX-License-Identifier: Apache-2.0
// Model seam — thin adapter interface over Anthropic SDK + Bedrock Converse.
// NO Vercel AI SDK. All provider wire-format normalization lives in the concrete impls.

import type { ModelMessage, ToolSpec, ToolCall, Usage } from "./types.js";

export type ModelStreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }           // emitted ONLY after input JSON fully accumulated
  | {
      type: "done";
      stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
      text: string;
      toolCalls: ToolCall[];
      usage: Usage;
      modelId: string;
    };

export interface ModelRequest {
  modelId: string;
  messages: ModelMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
  // no temperature/top_p on opus-4-8/fable; use effort instead
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface Model {
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelStreamEvent>;
  chat(req: ModelRequest, signal?: AbortSignal): Promise<Extract<ModelStreamEvent, { type: "done" }>>;
  supports(modelId: string): boolean; // eager validation; throws loud on mismatch
}

/**
 * estimateCostUsd — pure pricing table.
 * NOT inside Model so it can be called without a model instance.
 * Implementation lives in @draht/model/cost.ts.
 * The signature is declared here for reference; the concrete impl is in the model package.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type EstimateCostUsdFn = (modelId: string, u: Usage) => number;
