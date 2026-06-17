// SPDX-License-Identifier: Apache-2.0
// @draht/model — model adapters for Anthropic + Bedrock.
// NO Vercel AI SDK anywhere.

export { AnthropicModel } from "./anthropic.js";
export type { AnthropicMessagesClient } from "./anthropic.js";
export { BedrockModel } from "./bedrock.js";
export type { BedrockConverseClient } from "./bedrock.js";
export { estimateCostUsd } from "./cost.js";

import type { Model } from "@draht/core/seams";
import type { AnthropicMessagesClient } from "./anthropic.js";
import type { BedrockConverseClient } from "./bedrock.js";
import { AnthropicModel } from "./anthropic.js";
import { BedrockModel } from "./bedrock.js";

export type CreateModelClient =
  | { provider: "anthropic"; client: AnthropicMessagesClient }
  | { provider: "bedrock"; client: BedrockConverseClient };

/**
 * createModel — picks the adapter by `anthropic/...` vs `bedrock/...` prefix.
 * Pass in the provider client for testability; no env-var sniffing here.
 */
export function createModel(modelString: string, clientConfig: CreateModelClient): Model {
  if (modelString.startsWith("anthropic/")) {
    if (clientConfig.provider !== "anthropic") {
      throw new Error(
        `createModel: modelId "${modelString}" requires provider "anthropic" but got "${clientConfig.provider}"`,
      );
    }
    return new AnthropicModel(clientConfig.client);
  }
  if (modelString.startsWith("bedrock/")) {
    if (clientConfig.provider !== "bedrock") {
      throw new Error(
        `createModel: modelId "${modelString}" requires provider "bedrock" but got "${clientConfig.provider}"`,
      );
    }
    return new BedrockModel(clientConfig.client);
  }
  throw new Error(
    `createModel: unknown provider prefix in modelId "${modelString}". Expected "anthropic/" or "bedrock/"`,
  );
}
