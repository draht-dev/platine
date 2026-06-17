// SPDX-License-Identifier: Apache-2.0
// @draht/runtime-aws/handlers — Lambda handler entry points stub (P5 implements)
//
// Stable subpath "@draht/runtime-aws/handlers" — require.resolve()-able.
// SST bundles these at deploy (do NOT pre-bundle here).
//
// Handlers:
//   - executor: main SQS-triggered Lambda that runs the DAG executor loop
//   - trigger: EventBridge/schedule/webhook trigger normalization → runId + enqueue
//   - resume: ApprovalResume API handler (re-enqueues held run)
//   - ingress: HTTP channel inbound handler (verifies + normalizes → enqueue)

export {};
