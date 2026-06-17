// SPDX-License-Identifier: Apache-2.0
// Cross-provider conformance tests: same ModelMessage[] through both AnthropicModel
// and BedrockModel with scripted fake responses; assert identical tool-loop behavior.
// No network, no API keys — pure fake transports.

import { describe, it, expect, vi } from "vitest";
import { AnthropicModel } from "./anthropic.js";
import { BedrockModel } from "./bedrock.js";
import { estimateCostUsd } from "./cost.js";
import type { ModelMessage, ModelStreamEvent, ToolCall } from "@draht/core/seams";
import type { AnthropicMessagesClient } from "./anthropic.js";
import type { BedrockConverseClient } from "./bedrock.js";
import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type {
  MessageCreateParamsNonStreaming,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { Stream } from "@anthropic-ai/sdk/core/streaming.js";

// ─── Shared test scenario: 2-turn tool-calling exchange ──────────────────────
// Turn 1: user asks, model responds with tool_use
// Turn 2: user sends tool result, model responds with text completion

const BASE_MESSAGES: ModelMessage[] = [
  { role: "user", text: "What is the weather in Berlin?" },
];

const EXPECTED_TOOL_CALL: ToolCall = {
  id: "call_abc123",
  name: "get_weather",
  input: { city: "Berlin" },
};

const TOOLS = [
  {
    name: "get_weather",
    description: "Get weather for a city",
    inputSchema: {
      type: "object" as const,
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

// ─── Fake Anthropic client ────────────────────────────────────────────────────

function makeAnthropicFakeClient(): AnthropicMessagesClient {
  return {
    create: async (body: MessageCreateParamsNonStreaming) => {
      void body;
      return {
        content: [
          {
            type: "tool_use",
            id: EXPECTED_TOOL_CALL.id,
            name: EXPECTED_TOOL_CALL.name,
            input: EXPECTED_TOOL_CALL.input,
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      };
    },
    stream: (body: MessageCreateParamsNonStreaming) => {
      void body;
      // Return a fake streaming response that yields partial JSON for tool use
      const events: RawMessageStreamEvent[] = [
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [],
            model: "claude-haiku-4-5",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, cache_creation: null },
          },
        } as unknown as RawMessageStreamEvent,
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: EXPECTED_TOOL_CALL.id,
            name: EXPECTED_TOOL_CALL.name,
            input: {},
            caller: { type: "direct" },
          },
        } as unknown as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        } as unknown as RawMessageStreamEvent,
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"Berlin"}' },
        } as unknown as RawMessageStreamEvent,
        {
          type: "content_block_stop",
          index: 0,
        } as RawMessageStreamEvent,
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null, container: null },
          usage: { output_tokens: 5 },
        } as unknown as RawMessageStreamEvent,
      ];
      return makeAsyncIterable(events) as unknown as Stream<RawMessageStreamEvent>;
    },
  };
}

// ─── Fake Bedrock client ──────────────────────────────────────────────────────

function makeBedrockFakeClient(): BedrockConverseClient {
  return {
    converse: async (input: ConverseCommandInput): Promise<ConverseCommandOutput> => {
      void input;
      return {
        $metadata: {},
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: EXPECTED_TOOL_CALL.id,
                  name: EXPECTED_TOOL_CALL.name,
                  input: EXPECTED_TOOL_CALL.input,
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 100 },
      } as unknown as ConverseCommandOutput;
    },
    converseStream: async () => {
      type StreamEvent = {
        contentBlockStart?: {
          contentBlockIndex: number;
          start?: { toolUse?: { toolUseId: string; name: string } };
        };
        contentBlockDelta?: {
          contentBlockIndex: number;
          delta?: { text?: string; toolUse?: { input: string } };
        };
        contentBlockStop?: { contentBlockIndex: number };
        messageStop?: { stopReason?: string };
        metadata?: {
          usage?: {
            inputTokens: number;
            outputTokens: number;
          };
        };
      };

      const events: StreamEvent[] = [
        {
          contentBlockStart: {
            contentBlockIndex: 0,
            start: {
              toolUse: {
                toolUseId: EXPECTED_TOOL_CALL.id,
                name: EXPECTED_TOOL_CALL.name,
              },
            },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '{"city":' } },
          },
        },
        {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { toolUse: { input: '"Berlin"}' } },
          },
        },
        {
          contentBlockStop: { contentBlockIndex: 0 },
        },
        {
          messageStop: { stopReason: "tool_use" },
        },
        {
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        },
      ];
      return makeAsyncIterable(events);
    },
  };
}

// Helper to make a fake async iterable from an array
function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let i = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (i < items.length) {
            const value = items[i];
            if (value === undefined) {
              return Promise.resolve({ value: undefined as unknown as T, done: true });
            }
            i++;
            return Promise.resolve({ value, done: false });
          }
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        },
      };
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("cross-provider conformance", () => {
  it("chat(): both providers return identical ToolCall objects and done event", async () => {
    const anthropicModel = new AnthropicModel(makeAnthropicFakeClient());
    const bedrockModel = new BedrockModel(makeBedrockFakeClient());

    const req = {
      modelId: "anthropic/claude-haiku-4-5",
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    };

    const anthropicResult = await anthropicModel.chat(req);
    const bedrockResult = await bedrockModel.chat({
      ...req,
      modelId: "bedrock/eu.anthropic.claude-haiku-4-5",
    });

    // Both should report tool_use stop reason
    expect(anthropicResult.stopReason).toBe("tool_use");
    expect(bedrockResult.stopReason).toBe("tool_use");

    // Both should have the same tool call
    expect(anthropicResult.toolCalls).toHaveLength(1);
    expect(bedrockResult.toolCalls).toHaveLength(1);

    const aCall = anthropicResult.toolCalls[0]!;
    const bCall = bedrockResult.toolCalls[0]!;

    expect(aCall.id).toBe(EXPECTED_TOOL_CALL.id);
    expect(bCall.id).toBe(EXPECTED_TOOL_CALL.id);
    expect(aCall.name).toBe(EXPECTED_TOOL_CALL.name);
    expect(bCall.name).toBe(EXPECTED_TOOL_CALL.name);
    expect(aCall.input).toEqual(EXPECTED_TOOL_CALL.input);
    expect(bCall.input).toEqual(EXPECTED_TOOL_CALL.input);

    // Both should have usage
    expect(anthropicResult.usage.inputTokens).toBe(10);
    expect(bedrockResult.usage.inputTokens).toBe(10);
    expect(anthropicResult.usage.outputTokens).toBe(5);
    expect(bedrockResult.usage.outputTokens).toBe(5);
  });

  it("stream(): both providers emit tool_call ONLY after contentBlockStop, then done", async () => {
    const anthropicModel = new AnthropicModel(makeAnthropicFakeClient());
    const bedrockModel = new BedrockModel(makeBedrockFakeClient());

    const req = {
      modelId: "anthropic/claude-haiku-4-5",
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    };

    // Collect events from Anthropic
    const anthropicEvents: ModelStreamEvent[] = [];
    for await (const ev of anthropicModel.stream(req)) {
      anthropicEvents.push(ev);
    }

    // Collect events from Bedrock
    const bedrockEvents: ModelStreamEvent[] = [];
    for await (const ev of bedrockModel.stream({
      ...req,
      modelId: "bedrock/eu.anthropic.claude-haiku-4-5",
    })) {
      bedrockEvents.push(ev);
    }

    // Both should emit exactly one tool_call event (after contentBlockStop, not before)
    const aToolCallEvents = anthropicEvents.filter((e) => e.type === "tool_call");
    const bToolCallEvents = bedrockEvents.filter((e) => e.type === "tool_call");

    expect(aToolCallEvents).toHaveLength(1);
    expect(bToolCallEvents).toHaveLength(1);

    const aTc = aToolCallEvents[0] as Extract<ModelStreamEvent, { type: "tool_call" }>;
    const bTc = bToolCallEvents[0] as Extract<ModelStreamEvent, { type: "tool_call" }>;

    expect(aTc.call.id).toBe(EXPECTED_TOOL_CALL.id);
    expect(bTc.call.id).toBe(EXPECTED_TOOL_CALL.id);
    expect(aTc.call.name).toBe(EXPECTED_TOOL_CALL.name);
    expect(bTc.call.name).toBe(EXPECTED_TOOL_CALL.name);
    expect(aTc.call.input).toEqual(EXPECTED_TOOL_CALL.input);
    expect(bTc.call.input).toEqual(EXPECTED_TOOL_CALL.input);

    // Both should end with a done event
    const aDone = anthropicEvents[anthropicEvents.length - 1] as Extract<ModelStreamEvent, { type: "done" }>;
    const bDone = bedrockEvents[bedrockEvents.length - 1] as Extract<ModelStreamEvent, { type: "done" }>;

    expect(aDone.type).toBe("done");
    expect(bDone.type).toBe("done");
    expect(aDone.stopReason).toBe("tool_use");
    expect(bDone.stopReason).toBe("tool_use");

    // The done event should include the accumulated tool calls
    expect(aDone.toolCalls).toHaveLength(1);
    expect(bDone.toolCalls).toHaveLength(1);
  });

  it("stream(): partial json deltas accumulate to exactly ONE tool_call at contentBlockStop", async () => {
    const anthropicModel = new AnthropicModel(makeAnthropicFakeClient());

    const events: ModelStreamEvent[] = [];
    for await (const ev of anthropicModel.stream({
      modelId: "anthropic/claude-haiku-4-5",
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    })) {
      events.push(ev);
    }

    // Count tool_call events — must be exactly 1 (not 2 from 2 partial JSON deltas)
    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);

    // The accumulated input must be the full parsed JSON
    const tc = toolCallEvents[0] as Extract<ModelStreamEvent, { type: "tool_call" }>;
    expect(tc.call.input).toEqual({ city: "Berlin" });
  });

  it("stopReason mapping: tool_use → tool_use for both providers", async () => {
    const anthropicModel = new AnthropicModel(makeAnthropicFakeClient());
    const bedrockModel = new BedrockModel(makeBedrockFakeClient());

    const aResult = await anthropicModel.chat({
      modelId: "anthropic/claude-haiku-4-5",
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    });

    const bResult = await bedrockModel.chat({
      modelId: "bedrock/eu.anthropic.claude-haiku-4-5",
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    });

    expect(aResult.stopReason).toBe("tool_use");
    expect(bResult.stopReason).toBe("tool_use");
  });

  it("modelId is preserved in the done event", async () => {
    const anthropicModel = new AnthropicModel(makeAnthropicFakeClient());
    const anthropicModelId = "anthropic/claude-haiku-4-5";

    const result = await anthropicModel.chat({
      modelId: anthropicModelId,
      messages: BASE_MESSAGES,
      tools: TOOLS,
      maxTokens: 1024,
    });

    expect(result.modelId).toBe(anthropicModelId);
  });
});

// ─── supports() tests ─────────────────────────────────────────────────────────

describe("Model.supports()", () => {
  it("AnthropicModel supports anthropic/ prefix", () => {
    const m = new AnthropicModel(makeAnthropicFakeClient());
    expect(m.supports("anthropic/claude-haiku-4-5")).toBe(true);
    expect(m.supports("bedrock/eu.anthropic.claude-haiku-4-5")).toBe(false);
  });

  it("BedrockModel supports bedrock/ prefix", () => {
    const m = new BedrockModel(makeBedrockFakeClient());
    expect(m.supports("bedrock/eu.anthropic.claude-haiku-4-5")).toBe(true);
    expect(m.supports("anthropic/claude-haiku-4-5")).toBe(false);
  });
});

// ─── estimateCostUsd tests ────────────────────────────────────────────────────

describe("estimateCostUsd", () => {
  it("computes cost for a known anthropic model", () => {
    const cost = estimateCostUsd("anthropic/claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 0.8 per MTok input + 4.0 per MTok output = 4.8
    expect(cost).toBeCloseTo(4.8, 5);
  });

  it("computes cost for a known bedrock cross-region model", () => {
    const cost = estimateCostUsd("bedrock/eu.anthropic.claude-haiku-4-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4.8, 5);
  });

  it("returns 0 for unknown model and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cost = estimateCostUsd("bedrock/unknown-model-xyz", {
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown modelId"),
    );
    warnSpy.mockRestore();
  });

  it("handles small token counts without floating point issues", () => {
    const cost = estimateCostUsd("anthropic/claude-opus-4-8", {
      inputTokens: 100,
      outputTokens: 50,
    });
    // 100 tokens * $15.0/MTok = 100/1_000_000 * 15.0 = $0.0015
    // 50 tokens * $75.0/MTok = 50/1_000_000 * 75.0 = $0.00375
    // total = $0.00525
    expect(cost).toBeCloseTo(0.00525, 8);
  });
});
