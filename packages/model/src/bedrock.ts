// SPDX-License-Identifier: Apache-2.0
// BedrockModel — thin adapter over @aws-sdk/client-bedrock-runtime Converse/ConverseStream.
// All Bedrock wire-format normalization lives here (R5).
// Constructor-injectable for testability (accept the SDK client instance).

import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  Message as BedrockMessage,
  ContentBlock as BedrockContentBlock,
  SystemContentBlock,
  Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  Model,
  ModelRequest,
  ModelStreamEvent,
  ModelMessage,
  ToolCall,
  Usage,
} from "@draht/core/seams";

// Bedrock-specific normalized model ID: strip the "bedrock/" prefix
function stripBedrockPrefix(modelId: string): string {
  if (modelId.startsWith("bedrock/")) return modelId.slice("bedrock/".length);
  return modelId;
}

/**
 * Minimal interface for Bedrock client — for constructor injection / testing.
 */
export interface BedrockClientLike {
  send(command: { input: ConverseCommandInput }): Promise<ConverseCommandOutput>;
  sendStream(command: { input: ConverseStreamCommandInput }): Promise<ConverseStreamCommandOutput>;
}

/**
 * Normalize our ModelMessage[] to Bedrock Converse API format.
 * - System messages → SystemContentBlock[]
 * - Consecutive same-role messages are merged
 * - tool results → user message with toolResult content blocks
 */
function normalizeMessages(messages: ModelMessage[]): {
  system: SystemContentBlock[];
  messages: BedrockMessage[];
} {
  const systemBlocks: SystemContentBlock[] = [];
  const result: BedrockMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemBlocks.push({ text: msg.text });
      continue;
    }

    if (msg.role === "user") {
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && last.content !== undefined) {
        last.content.push({ text: msg.text });
      } else {
        result.push({ role: "user", content: [{ text: msg.text }] });
      }
    } else if (msg.role === "assistant") {
      const content: BedrockContentBlock[] = [{ text: msg.text }];
      if (msg.toolCalls !== undefined) {
        for (const tc of msg.toolCalls) {
          content.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.name,
              input: tc.input as unknown as ReturnType<typeof JSON.parse>,
            },
          });
        }
      }
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "assistant" && last.content !== undefined) {
        last.content.push(...content);
      } else {
        result.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool") {
      // Plural tool results → batch into single user message with toolResult content blocks
      const toolResultBlocks: BedrockContentBlock[] = msg.results.map((r) => ({
        toolResult: {
          toolUseId: r.toolUseId,
          content: [{ text: r.content }],
          status: r.isError === true ? ("error" as const) : ("success" as const),
        },
      }));
      const last = result[result.length - 1];
      if (last !== undefined && last.role === "user" && last.content !== undefined) {
        last.content.push(...toolResultBlocks);
      } else {
        result.push({ role: "user", content: toolResultBlocks });
      }
    }
  }

  return { system: systemBlocks, messages: result };
}

function buildToolConfig(specs: ModelRequest["tools"]): ConverseCommandInput["toolConfig"] {
  if (specs === undefined || specs.length === 0) return undefined;
  return {
    tools: specs.map(
      (s): BedrockTool => ({
        toolSpec: {
          name: s.name,
          description: s.description,
          inputSchema: { json: s.inputSchema as unknown as ReturnType<typeof JSON.parse> },
        },
      }),
    ),
  };
}

function mapUsage(u: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
}): Usage {
  const result: Usage = {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
  };
  if (u.cacheReadInputTokens !== undefined) {
    result.cacheReadTokens = u.cacheReadInputTokens;
  }
  if (u.cacheWriteInputTokens !== undefined) {
    result.cacheWriteTokens = u.cacheWriteInputTokens;
  }
  return result;
}

function mapStopReason(
  r: string | undefined,
): "end_turn" | "tool_use" | "max_tokens" | "refusal" {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "content_filtered":
      return "refusal";
    default:
      return "end_turn";
  }
}

/**
 * Minimal Bedrock client interface for constructor injection.
 * We keep it structural to avoid importing the actual command classes in tests.
 */
export interface BedrockConverseClient {
  converse(input: ConverseCommandInput): Promise<ConverseCommandOutput>;
  converseStream(
    input: ConverseStreamCommandInput,
  ): Promise<AsyncIterable<{
    messageStart?: { role?: string };
    contentBlockStart?: {
      contentBlockIndex: number;
      start?: {
        toolUse?: { toolUseId: string; name: string };
      };
    };
    contentBlockDelta?: {
      contentBlockIndex: number;
      delta?: {
        text?: string;
        toolUse?: { input: string };
      };
    };
    contentBlockStop?: { contentBlockIndex: number };
    messageStop?: { stopReason?: string };
    metadata?: {
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    };
  }>>;
}

export class BedrockModel implements Model {
  private readonly _client: BedrockConverseClient;
  private readonly _supportedPrefixes: string[];

  constructor(client: BedrockConverseClient, opts?: { supportedPrefixes?: string[] }) {
    this._client = client;
    this._supportedPrefixes = opts?.supportedPrefixes ?? ["bedrock/"];
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
    const modelIdBare = stripBedrockPrefix(req.modelId);
    const { system, messages } = normalizeMessages(req.messages);
    const toolConfig = buildToolConfig(req.tools);

    const input: ConverseCommandInput = {
      modelId: modelIdBare,
      messages,
      system: system.length > 0 ? system : undefined,
      inferenceConfig: { maxTokens: req.maxTokens },
      toolConfig,
    };

    // Abort signal — not natively supported by Bedrock SDK here,
    // but we'll pass it through AbortController if the client supports it
    void signal; // acknowledged but Converse doesn't accept signal directly

    const response = await this._client.converse(input);

    let text = "";
    const toolCalls: ToolCall[] = [];

    const outputMessage = response.output?.message;
    if (outputMessage?.content !== undefined) {
      for (const block of outputMessage.content) {
        if (block.text !== undefined) {
          text += block.text;
        } else if (block.toolUse !== undefined) {
          const tu = block.toolUse;
          if (tu.toolUseId !== undefined && tu.name !== undefined) {
            toolCalls.push({
              id: tu.toolUseId,
              name: tu.name,
              input: (tu.input as Record<string, unknown>) ?? {},
            });
          }
        }
      }
    }

    return {
      type: "done",
      stopReason: mapStopReason(response.stopReason),
      text,
      toolCalls,
      usage: response.usage !== undefined
        ? mapUsage(response.usage)
        : { inputTokens: 0, outputTokens: 0 },
      modelId: req.modelId,
    };
  }

  async *stream(
    req: ModelRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    const modelIdBare = stripBedrockPrefix(req.modelId);
    const { system, messages } = normalizeMessages(req.messages);
    const toolConfig = buildToolConfig(req.tools);

    void signal; // acknowledged

    const input: ConverseStreamCommandInput = {
      modelId: modelIdBare,
      messages,
      system: system.length > 0 ? system : undefined,
      inferenceConfig: { maxTokens: req.maxTokens },
      toolConfig,
    };

    const streamIterable = await this._client.converseStream(input);

    let accText = "";
    const toolCalls: ToolCall[] = [];
    // Map from content block index to partial JSON string
    const pendingToolInputs = new Map<
      number,
      { id: string; name: string; jsonAcc: string }
    >();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" = "end_turn";

    for await (const event of streamIterable) {
      if (event.contentBlockStart !== undefined) {
        const cbs = event.contentBlockStart;
        const tu = cbs.start?.toolUse;
        if (tu !== undefined) {
          pendingToolInputs.set(cbs.contentBlockIndex, {
            id: tu.toolUseId,
            name: tu.name,
            jsonAcc: "",
          });
        }
      } else if (event.contentBlockDelta !== undefined) {
        const cbd = event.contentBlockDelta;
        if (cbd.delta?.text !== undefined) {
          accText += cbd.delta.text;
          yield { type: "text", delta: cbd.delta.text };
        } else if (cbd.delta?.toolUse !== undefined) {
          const pending = pendingToolInputs.get(cbd.contentBlockIndex);
          if (pending !== undefined) {
            pending.jsonAcc += cbd.delta.toolUse.input;
          }
        }
      } else if (event.contentBlockStop !== undefined) {
        const idx = event.contentBlockStop.contentBlockIndex;
        const pending = pendingToolInputs.get(idx);
        if (pending !== undefined) {
          pendingToolInputs.delete(idx);
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
      } else if (event.messageStop !== undefined) {
        stopReason = mapStopReason(event.messageStop.stopReason);
      } else if (event.metadata?.usage !== undefined) {
        usage = mapUsage(event.metadata.usage);
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
