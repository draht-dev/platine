// SPDX-License-Identifier: Apache-2.0
// AnthropicModel — thin adapter over @anthropic-ai/sdk.
// All Anthropic wire-format normalization lives here (R5).
// Constructor-injectable for testability (accept the SDK client instance).

import type { Anthropic as AnthropicClient } from "@anthropic-ai/sdk";
import type {
  MessageCreateParamsNonStreaming,
  MessageParam,
  ContentBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  TextBlockParam,
  Tool as AnthropicTool,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { Stream } from "@anthropic-ai/sdk/core/streaming.js";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelMessage,
  ToolCall,
  Usage,
} from "@draht/core/seams";

// Models that do NOT support temperature/top_p/thinking — use effort instead.
const EXTENDED_THINKING_MODELS = new Set([
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-opus-4-7",
  "claude-mythos-5",
  "claude-mythos-preview",
]);

function isThinkingModel(modelId: string): boolean {
  for (const m of EXTENDED_THINKING_MODELS) {
    if (modelId.includes(m)) return true;
  }
  return false;
}

function stripPrefix(modelId: string): string {
  if (modelId.startsWith("anthropic/")) return modelId.slice("anthropic/".length);
  return modelId;
}

/**
 * Normalize our ModelMessage[] to Anthropic Messages API format.
 * - System messages are extracted (returned separately)
 * - Consecutive same-role messages are merged
 * - tool results are batched into a single user message
 */
function normalizeMessages(messages: ModelMessage[]): {
  system: string | undefined;
  messages: MessageParam[];
} {
  let system: string | undefined;
  const result: MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system = system !== undefined ? `${system}\n${msg.text}` : msg.text;
      continue;
    }

    if (msg.role === "user") {
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user") {
        // Merge consecutive user messages
        const content = last.content;
        if (typeof content === "string") {
          last.content = [
            { type: "text", text: content } satisfies TextBlockParam,
            { type: "text", text: msg.text } satisfies TextBlockParam,
          ];
        } else {
          (content as ContentBlockParam[]).push({
            type: "text",
            text: msg.text,
          } satisfies TextBlockParam);
        }
      } else {
        result.push({ role: "user", content: msg.text });
      }
    } else if (msg.role === "assistant") {
      const content: ContentBlockParam[] = [
        { type: "text", text: msg.text } satisfies TextBlockParam,
      ];
      if (msg.toolCalls !== undefined) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          } satisfies ToolUseBlockParam);
        }
      }
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "assistant") {
        // Merge consecutive assistant messages
        if (typeof last.content === "string") {
          last.content = [
            { type: "text", text: last.content } satisfies TextBlockParam,
            ...content,
          ];
        } else {
          (last.content as ContentBlockParam[]).push(...content);
        }
      } else {
        result.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      // Plural tool results → batch into a single user message with tool_result blocks
      const toolResultBlocks: ContentBlockParam[] = msg.results.map(
        (r): ToolResultBlockParam => {
          const block: ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: r.toolUseId,
            content: r.content,
          };
          if (r.isError !== undefined) {
            block.is_error = r.isError;
          }
          return block;
        },
      );
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user") {
        // Merge into existing user message
        if (typeof last.content === "string") {
          last.content = [
            { type: "text", text: last.content } satisfies TextBlockParam,
            ...toolResultBlocks,
          ];
        } else {
          (last.content as ContentBlockParam[]).push(...toolResultBlocks);
        }
      } else {
        result.push({ role: "user", content: toolResultBlocks });
      }
    }
  }

  return { system, messages: result };
}

function buildTools(specs: ModelRequest["tools"]): AnthropicTool[] | undefined {
  if (specs === undefined || specs.length === 0) return undefined;
  return specs.map(
    (s): AnthropicTool => ({
      name: s.name,
      description: s.description,
      input_schema: {
        type: "object",
        properties: s.inputSchema.properties,
        required: s.inputSchema.required ?? null,
      },
    }),
  );
}

function mapUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  const result: Usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  if (u.cache_read_input_tokens != null) {
    result.cacheReadTokens = u.cache_read_input_tokens;
  }
  if (u.cache_creation_input_tokens != null) {
    result.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  return result;
}

function mapStopReason(
  r: string | null | undefined,
): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

// Minimal subset of Anthropic client we actually call — for constructor injection / testing.
export interface AnthropicMessagesClient {
  create(
    body: MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<{
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };
  }>;
  stream(
    body: MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Stream<RawMessageStreamEvent>;
}

export class AnthropicModel implements Model {
  private readonly _client: AnthropicMessagesClient;
  private readonly _supportedPrefixes: string[];

  constructor(
    client: AnthropicMessagesClient | AnthropicClient,
    opts?: { supportedPrefixes?: string[] },
  ) {
    // Accept either a raw AnthropicClient (has .messages property) or
    // an already-extracted AnthropicMessagesClient.
    if ("messages" in client && client.messages !== undefined) {
      this._client = (client as AnthropicClient).messages as unknown as AnthropicMessagesClient;
    } else {
      this._client = client as AnthropicMessagesClient;
    }
    this._supportedPrefixes = opts?.supportedPrefixes ?? ["anthropic/", "claude-"];
  }

  supports(modelId: string): boolean {
    for (const p of this._supportedPrefixes) {
      if (modelId.startsWith(p)) return true;
    }
    return false;
  }

  async chat(
    req: ModelRequest,
    signal?: AbortSignal,
  ): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    const modelIdBare = stripPrefix(req.modelId);
    const { system, messages } = normalizeMessages(req.messages);
    const tools = buildTools(req.tools);

    const body: MessageCreateParamsNonStreaming = {
      model: modelIdBare,
      max_tokens: req.maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(req.effort !== undefined && isThinkingModel(modelIdBare)
        ? { output_config: { effort: req.effort } }
        : {}),
      stream: false,
    };

    const response = await this._client.create(
      body,
      signal !== undefined ? { signal } : undefined,
    );

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      } else if (
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    return {
      type: "done",
      stopReason: mapStopReason(response.stop_reason),
      text,
      toolCalls,
      usage: mapUsage(response.usage),
      modelId: req.modelId,
    };
  }

  async *stream(
    req: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const modelIdBare = stripPrefix(req.modelId);
    const { system, messages } = normalizeMessages(req.messages);
    const tools = buildTools(req.tools);

    const body: MessageCreateParamsNonStreaming = {
      model: modelIdBare,
      max_tokens: req.maxTokens,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...(req.effort !== undefined && isThinkingModel(modelIdBare)
        ? { output_config: { effort: req.effort } }
        : {}),
      stream: false,
    };

    const streamObj = this._client.stream(
      body,
      signal !== undefined ? { signal } : undefined,
    );

    // Accumulators for streaming
    let accText = "";
    const toolCalls: ToolCall[] = [];
    // Map from content block index to partial JSON string
    const pendingToolInputs = new Map<
      number,
      { id: string; name: string; jsonAcc: string }
    >();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = "end_turn";

    for await (const event of streamObj) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          pendingToolInputs.set(event.index, {
            id: block.id,
            name: block.name,
            jsonAcc: "",
          });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "text_delta" && "text" in delta) {
          const text = (delta as { type: string; text: string }).text;
          accText += text;
          yield { type: "text", delta: text };
        } else if (delta.type === "input_json_delta" && "partial_json" in delta) {
          const partialJson = (delta as { type: string; partial_json: string }).partial_json;
          const pending = pendingToolInputs.get(event.index);
          if (pending !== undefined) {
            pending.jsonAcc += partialJson;
          }
        }
      } else if (event.type === "content_block_stop") {
        const pending = pendingToolInputs.get(event.index);
        if (pending !== undefined) {
          pendingToolInputs.delete(event.index);
          // Tool input JSON fully accumulated — emit the tool_call event NOW
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(pending.jsonAcc) as Record<string, unknown>;
          } catch {
            parsedInput = {};
          }
          const call: ToolCall = {
            id: pending.id,
            name: pending.name,
            input: parsedInput,
          };
          toolCalls.push(call);
          yield { type: "tool_call", call };
        }
      } else if (event.type === "message_delta") {
        stopReason = mapStopReason(event.delta.stop_reason);
        usage = {
          ...usage,
          outputTokens: event.usage.output_tokens,
        };
      } else if (event.type === "message_start") {
        usage = mapUsage(event.message.usage);
      }
    }

    yield {
      type: "done",
      stopReason,
      text: accText,
      toolCalls,
      usage,
      modelId: req.modelId,
    };
  }
}
