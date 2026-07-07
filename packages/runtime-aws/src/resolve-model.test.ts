// SPDX-License-Identifier: Apache-2.0
/**
 * resolve-model.test.ts — pure provider-resolution tests, plus
 * resolveModelFromEnv() end-to-end DRAHT_DEFAULT_MODEL validation tests.
 *
 * resolveModelFromEnv() constructs real SDK *client* objects (BedrockRuntimeClient /
 * Anthropic), but SDK client construction alone performs no network I/O or
 * credential resolution that would fail in CI — only `.send()` / `.messages.create()`
 * calls do, and resolveModelFromEnv() never invokes those (it only calls
 * `.supports()` on the constructed Model adapter). So we can safely exercise it
 * directly with env vars, proving the BLOCKER 1 fix: `DRAHT_DEFAULT_MODEL` holds
 * the RAW model id (no provider prefix), and resolveModelFromEnv must validate
 * it against `${provider}/${defaultModel}` — NOT the raw id — since
 * `BedrockModel.supports()` / `AnthropicModel.supports()` require the
 * provider-prefixed form.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveProvider, resolveModelFromEnv } from "./resolve-model.js";

describe("resolveProvider", () => {
  it("defaults to anthropic when DRAHT_MODEL_PROVIDER is unset", () => {
    expect(resolveProvider({})).toBe("anthropic");
  });

  it("returns anthropic when DRAHT_MODEL_PROVIDER=anthropic", () => {
    expect(resolveProvider({ DRAHT_MODEL_PROVIDER: "anthropic" })).toBe("anthropic");
  });

  it("returns bedrock when DRAHT_MODEL_PROVIDER=bedrock", () => {
    expect(resolveProvider({ DRAHT_MODEL_PROVIDER: "bedrock" })).toBe("bedrock");
  });

  it("throws on an invalid DRAHT_MODEL_PROVIDER value", () => {
    expect(() => resolveProvider({ DRAHT_MODEL_PROVIDER: "openai" })).toThrow(
      /invalid DRAHT_MODEL_PROVIDER/,
    );
  });
});

describe("resolveModelFromEnv — DRAHT_DEFAULT_MODEL validation (BLOCKER 1)", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["DRAHT_MODEL_PROVIDER"];
    delete process.env["DRAHT_DEFAULT_MODEL"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("succeeds for a RAW (unprefixed) Bedrock region-prefixed model id — the exact deployed-executor shape", async () => {
    process.env["DRAHT_MODEL_PROVIDER"] = "bedrock";
    process.env["DRAHT_DEFAULT_MODEL"] = "eu.anthropic.claude-haiku-4-5";

    // Must NOT throw — before the fix, BedrockModel.supports("eu.anthropic.claude-haiku-4-5")
    // was always false (no "bedrock/" prefix), so this call threw at cold start,
    // outside the per-record try/catch, DLQ-ing the entire batch.
    await expect(resolveModelFromEnv()).resolves.toBeDefined();
  });

  it("succeeds for a RAW Anthropic model id (no provider prefix)", async () => {
    process.env["DRAHT_MODEL_PROVIDER"] = "anthropic";
    process.env["DRAHT_DEFAULT_MODEL"] = "claude-haiku-4-5";
    process.env["ANTHROPIC_API_KEY"] = "test-key";

    await expect(resolveModelFromEnv()).resolves.toBeDefined();
  });
});
