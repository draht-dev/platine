// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/runtime-aws/handlers — Lambda handler entry points.
 *
 * Stable subpath "@draht/runtime-aws/handlers" — require.resolve()-able.
 * SST bundles these at deploy (do NOT pre-bundle here).
 *
 * Handlers:
 *   - executor:         SQS-triggered Lambda that runs the DAG executor loop.
 *                       v1 STUB tool dispatch — user tool code is NOT bundled
 *                       (fixed module, no static workflow import).
 *   - makeExecutorHandler: factory for the PER-AGENT executor entry emitted by
 *                       `platine build` (`.platine/executor.entry.ts`), which
 *                       statically imports the agent's workflow so esbuild
 *                       bundles its tools + wires a RealToolsDispatcher.
 *   - trigger:          EventBridge/schedule/webhook trigger → runId derivation + enqueue
 *   - resume:           ApprovalResume API handler (re-enqueues held run)
 *   - ingress:          HTTP channel inbound handler (verifies + normalizes → enqueue)
 *
 * Each handler constructs the Adapters bundle from environment variables:
 *   DRAHT_TABLE_NAME     — DynamoDB table name
 *   DRAHT_BUS_NAME       — EventBridge bus name
 *   DRAHT_QUEUE_URL      — SQS queue URL
 *   DRAHT_MANIFEST_ID    — manifest agent ID (for trigger handler)
 *   DRAHT_MANIFEST_REV   — manifest revision (for trigger handler)
 *   DRAHT_CHANNEL_AUTH   — bearer token for HTTP channel auth (optional)
 *   DRAHT_MODEL_PROVIDER — "anthropic" (default) or "bedrock" (makeExecutorHandler only)
 *   DRAHT_DEFAULT_MODEL  — optional; validated against the resolved Model adapter
 */

export { executorHandler } from "./executor.js";
export { triggerHandler } from "./trigger.js";
export { resumeHandler } from "./resume.js";
export { ingressHandler } from "./ingress.js";
export { makeExecutorHandler } from "./make-executor.js";
export type { MakeExecutorOptions, ExecutorLambdaHandler } from "./make-executor.js";
