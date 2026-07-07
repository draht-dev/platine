// SPDX-License-Identifier: Apache-2.0
/**
 * sst.config.ts — deployable SST configuration for the reference playbook.
 *
 * Prerequisites:
 *   1. Build the manifest:   platine build
 *   2. Deploy to AWS:        sst deploy --stage <name>
 *
 * The manifest at .platine/manifest.json must exist before deploy.
 * Run `platine build` from this directory to produce it.
 *
 * The deployed stack exposes:
 *   - SupportTriageAgentUrl              — the Function URL endpoint for the HTTP channel
 *   - SupportTriageAgentTableName        — the DynamoDB table name
 *   - SupportTriageAgentResumeUrl        — the IAM-authenticated approval-resume Function URL
 *   - SupportTriageAgentManifestRevision — the manifest revision baked into the deployment
 *
 * Example end-to-end:
 *   1. platine build
 *   2. sst deploy --stage dev
 *   3. curl -X POST $SupportTriageAgentUrl -H 'Content-Type: application/json' \
 *        -d '{"ticketId":"t_001","body":"I was charged twice and cannot log in."}'
 *   4. platine runs list --table <DrahtTableName>
 *   5. platine runs approve --run-id <runId> --action-id <actionId> --decision approved
 */

/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "draht-reference-playbook",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },

  async run() {
    // Import sst.ts inside run() so the globally-injected sst/aws/$util
    // namespaces are available when provisionSupportTriageAgent() is called.
    const { provisionSupportTriageAgent } = await import("./sst.js");

    const supportTriageAgent = provisionSupportTriageAgent();

    // Expose the HTTP endpoint + conformance-harness-required outputs.
    return {
      SupportTriageAgentUrl: supportTriageAgent.httpUrl,
      SupportTriageAgentTableName: supportTriageAgent.tableName,
      SupportTriageAgentResumeUrl: supportTriageAgent.resumeUrl,
      SupportTriageAgentManifestRevision: supportTriageAgent.manifestRevision,
    };
  },
});
