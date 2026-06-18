// SPDX-License-Identifier: Apache-2.0
/**
 * sst.ts — thin wrapper exporting the draht.Agent call for this playbook.
 *
 * Imported by sst.config.ts inside run() so the globally-injected SST/Pulumi
 * namespaces (sst, aws, $util, $app, $jsonStringify) are in scope.
 *
 * Usage in sst.config.ts:
 *   const { supportTriageAgent } = await import("./sst.js");
 */

import { draht } from "@draht/sst";
import type { DrahtAgentOutput } from "@draht/sst";

/**
 * Provisions all AWS resources for the support-triage reference playbook.
 *
 * Called INSIDE sst.config.ts run() — do NOT call at module load time.
 *
 * Resource breakdown:
 *  - SQS queue + DLQ (visibilityTimeout > Lambda timeout)
 *  - EventBridge bus (own, created by the component)
 *  - DynamoDB table (managed, removal:retain, deletionProtection:true)
 *  - Executor Lambda + cron/ingress Lambdas as needed
 *  - Function URL (http channel fallback — url:true)
 *  - CloudWatch DLQ alarm
 *  - sst.Linkable exposing queueUrl, httpUrl, tableName, manifestRevision
 */
export function provisionSupportTriageAgent(): DrahtAgentOutput {
  return draht.Agent("SupportTriageAgent", {
    // Path to the compiled manifest — produced by `platine build`.
    manifest: "./.platine/manifest.json",

    // Model: Bedrock eu region with claude-haiku-4-5 as specified in the spec.
    model: {
      provider: "bedrock",
      defaultModel: "eu.anthropic.claude-haiku-4-5",
    },

    // Storage: managed own DynamoDB table — the only safe default.
    // removal:'retain' + deletionProtection ensures the table survives
    // `sst remove` so in-flight runs can be resumed after redeploy (T5/T6).
    storage: { mode: "managed", retain: true },

    // HTTP channel: no shared router in this standalone playbook, so fall
    // back to a plain Function URL (url:true is the fallback path).
    channels: [{ kind: "http" }],

    // Single-tenant: the v1 default and the only proven mode.
    tenancy: { mode: "single" },

    // Timeout: set close to the 15-minute Lambda hard limit so the soft
    // time-budget (timeout − 3 min) has headroom for a ~12-minute run.
    timeout: "14 minutes",
  });
}
