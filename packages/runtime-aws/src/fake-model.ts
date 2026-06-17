// SPDX-License-Identifier: Apache-2.0
/**
 * fake-model.ts — Scripted fake Model for tests. NO network, NO API keys.
 * Constructor-injected response scripts drive the model tool-loop.
 */

import type { Model, ModelRequest, ModelStreamEvent, Usage } from "@draht/core/seams";

export type FakeModelResponse =
  | { stopReason: "end_turn"; text: string; toolCalls?: never }
  | {
      stopReason: "tool_use";
      text: string;
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    };

/**
 * ScriptedModel — returns responses from a pre-configured script queue.
 * Pops responses in order. If the script is exhausted, returns a default end_turn.
 */
export class ScriptedModel implements Model {
  private readonly script: FakeModelResponse[];
  private readonly usage: Usage;

  constructor(
    script: FakeModelResponse[],
    usage: Usage = { inputTokens: 10, outputTokens: 5 },
  ) {
    this.script = [...script];
    this.usage = usage;
  }

  async chat(
    req: ModelRequest,
  ): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    void req;
    const next = this.script.shift() ?? { stopReason: "end_turn" as const, text: "done" };
    return {
      type: "done",
      stopReason: next.stopReason,
      text: next.text,
      toolCalls: next.toolCalls ?? [],
      usage: { ...this.usage },
      modelId: req.modelId,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const result = await this.chat(req);
    yield result;
  }

  supports(modelId: string): boolean {
    void modelId;
    return true; // accept any modelId in tests
  }
}
