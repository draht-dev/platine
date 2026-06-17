// SPDX-License-Identifier: Apache-2.0
// @draht/model — model adapters stub (P3 implements AnthropicModel + BedrockModel)
//
// Our own thin adapter over provider SDKs. NO Vercel AI SDK anywhere.
// Independence + clean SST-partner narrative.
//
// Providers: Anthropic (direct, ANTHROPIC_API_KEY) + AWS Bedrock Converse.
// Local dev default: Anthropic. Deployed default: Bedrock (execution-role IAM).
//
// CRITICAL: NO temperature/top_p/thinking params on opus-4-8/fable models.
// Use the `effort` enum instead: "low" | "medium" | "high" | "xhigh" | "max".
// This is enforced at the Model seam level (ModelRequest in @draht/core/seams).
//
// Provider wire-format differences (R5 in the risk register) are contained entirely
// inside AnthropicModel and BedrockModel — not at the seam boundary.
// Key differences to handle in P3:
// - tool-block shapes differ between providers
// - role:tool results must be plural/batched (alternation safe)
// - consecutive same-role messages need merging
// - system prompt separation differs
// - streaming tool-call accumulation to contentBlockStop (Bedrock)
// - model-id namespace + region routing (Bedrock cross-region inference profiles)

export {};
