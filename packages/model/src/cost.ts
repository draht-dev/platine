// SPDX-License-Identifier: Apache-2.0
// Pure pricing table for estimateCostUsd.
// Unknown model IDs return 0 with a console.warn.

import type { Usage } from "@draht/core/seams";

// Pricing in USD per million tokens (MTok)
// Source: Anthropic / Bedrock public pricing as of 2026-06
interface PricingEntry {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING_TABLE: Record<string, PricingEntry> = {
  // Anthropic direct (prefix: anthropic/)
  "anthropic/claude-opus-4-8": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "anthropic/claude-opus-4-6": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "anthropic/claude-sonnet-4-6": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "anthropic/claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "anthropic/claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  "anthropic/claude-fable-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  // Bedrock cross-region inference profiles (prefix: bedrock/)
  "bedrock/anthropic.claude-opus-4-8-20250514-v1:0": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "bedrock/anthropic.claude-3-haiku-20240307-v1:0": { inputPerMTok: 0.25, outputPerMTok: 1.25 },
  // Cross-region inference profile examples
  "bedrock/eu.anthropic.claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  "bedrock/us.anthropic.claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  "bedrock/eu.anthropic.claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "bedrock/us.anthropic.claude-sonnet-4-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
};

export function estimateCostUsd(modelId: string, u: Usage): number {
  const entry = PRICING_TABLE[modelId];
  if (entry === undefined) {
    console.warn(`[draht/model] estimateCostUsd: unknown modelId "${modelId}", returning 0`);
    return 0;
  }
  const inputCost = (u.inputTokens / 1_000_000) * entry.inputPerMTok;
  const outputCost = (u.outputTokens / 1_000_000) * entry.outputPerMTok;
  return inputCost + outputCost;
}
