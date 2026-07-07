// SPDX-License-Identifier: Apache-2.0
/**
 * resolve-model.ts — construct a real Model adapter from the deployed
 * executor Lambda's environment variables:
 *
 *   DRAHT_MODEL_PROVIDER  — "anthropic" (default) or "bedrock"
 *   DRAHT_DEFAULT_MODEL   — optional; if set, validated against the
 *                           constructed adapter's `.supports()` so a
 *                           provider/model mismatch fails fast at cold start
 *                           instead of at the first model.chat() call.
 *   ANTHROPIC_API_KEY     — required when DRAHT_MODEL_PROVIDER=anthropic
 *
 * Mirrors packages/cli/src/dev.ts::resolveModel() — same Bedrock
 * ConverseCommand → BedrockConverseClient structural-adapter pattern and the
 * same AnthropicModel construction — but reads the DEPLOYED executor's env
 * vars instead of dev-mode ANTHROPIC_API_KEY-presence auto-detection.
 *
 * @aws-sdk/client-bedrock-runtime and @anthropic-ai/sdk are optionalDependencies
 * of this package and are ONLY reached via lazy `await import()`, so neither is
 * pulled into the esbuild bundle unless the corresponding provider is actually
 * selected at runtime (matches the CLI's existing pattern).
 */

import type { Model } from "@draht/core/seams";

export type ModelProvider = "anthropic" | "bedrock";

/** Pure env-var → provider resolution (no I/O — testable without real SDKs). */
export function resolveProvider(
  env: Record<string, string | undefined> = process.env,
): ModelProvider {
  const raw = env["DRAHT_MODEL_PROVIDER"];
  if (raw === "bedrock") return "bedrock";
  if (raw === "anthropic" || raw === undefined) return "anthropic";
  throw new Error(
    `[executor] invalid DRAHT_MODEL_PROVIDER "${raw}" — expected "anthropic" or "bedrock"`,
  );
}

/**
 * resolveModelFromEnv — construct the real Model adapter for the deployed
 * executor Lambda from environment variables.
 */
export async function resolveModelFromEnv(): Promise<Model> {
  const provider = resolveProvider(process.env);
  const defaultModel = process.env["DRAHT_DEFAULT_MODEL"];

  let model: Model;

  if (provider === "bedrock") {
    // Adapt the AWS SDK BedrockRuntimeClient to BedrockConverseClient — the
    // structural adapter wraps send(ConverseCommand) → converse()/converseStream()
    // (same pattern as dev.ts's resolveModel()).
    const { BedrockModel } = await import("@draht/model");
    const {
      BedrockRuntimeClient,
      ConverseCommand,
      ConverseStreamCommand,
    } = await import("@aws-sdk/client-bedrock-runtime");
    type BCI = import("@draht/model").BedrockConverseClient;
    type ConverseIn = Parameters<BCI["converse"]>[0];
    type ConverseStreamIn = Parameters<BCI["converseStream"]>[0];
    const sdkClient = new BedrockRuntimeClient({});

    // The AWS SDK send() return types don't precisely match the structural
    // BedrockConverseClient interface, so we use `as unknown` to bridge the gap.
    // The underlying method signatures are compatible at runtime.
    const bedrockAdapter: BCI = {
      converse: (input: ConverseIn) =>
        sdkClient.send(new ConverseCommand(input)) as unknown as ReturnType<BCI["converse"]>,
      converseStream: (input: ConverseStreamIn) =>
        sdkClient.send(new ConverseStreamCommand(input)) as unknown as ReturnType<BCI["converseStream"]>,
    };

    model = new BedrockModel(bedrockAdapter);
  } else {
    const { AnthropicModel } = await import("@draht/model");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    const sdkClient = new Anthropic({ apiKey });

    // AnthropicModel accepts the full Anthropic client (has .messages property)
    model = new AnthropicModel(
      sdkClient as unknown as import("@draht/model").AnthropicMessagesClient,
    );
  }

  // NOTE: DRAHT_DEFAULT_MODEL holds the RAW model id (e.g.
  // "eu.anthropic.claude-haiku-4-5") — sst/src/plan.ts's stripRegionPrefix()/
  // inference-profile detection depends on this env var carrying the raw,
  // unprefixed-by-provider id, so we must NOT rewrite the env var itself.
  // Model.supports() instead expects the fully-qualified `${provider}/${id}`
  // form (see executor.ts's `${agentDef.model.provider}/${agentDef.model.modelId}`
  // construction) — validate against that qualified form here instead.
  if (defaultModel !== undefined && !model.supports(`${provider}/${defaultModel}`)) {
    throw new Error(
      `[executor] DRAHT_DEFAULT_MODEL "${defaultModel}" is not supported by the ` +
        `DRAHT_MODEL_PROVIDER "${provider}" adapter`,
    );
  }

  return model;
}
