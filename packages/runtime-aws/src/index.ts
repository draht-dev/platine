// SPDX-License-Identifier: Apache-2.0
// @draht/runtime-aws — AWS serverless runtime (P4 + P5)
//
// Executor + in-memory seam implementations (P4):
//   - executor.ts: level scheduler, Engine-3 flush+drain, fan-out, approval gate
//   - runtime-local.ts: MemoryStorage/Queue/Bus — SAME executor.ts behind seams (for `platine dev`)
//
// AWS seam implementations (P5):
//   - storage-dynamo.ts:     DynamoStorage (ElectroDB single-table, transactWrite step+sideeffect)
//   - event-eventbridge.ts:  EventBridgeBus (chainDepth guard, best-effort)
//   - channel-http.ts:       HttpChannel (InboundChannel + OutboundChannel, NDJSON streaming)
//   - channel-slack.ts:      SlackChannel (InboundChannel, HMAC-SHA256 signature verification)
//   - runtime-aws.ts:        AwsRuntime (SQS submit/resume/cancel/getRun)
//
// Key durability invariants (ALL greenfield — none exists in agent-studio reference):
// 1. deterministic runId at channel/trigger boundary BEFORE enqueue (never nanoid() in executor)
// 2. mandatory SIDEEFFECT# pre-check on every tool dispatch, co-written with step-completed
//    via commitStepWithSideEffect (atomic step-completed + SIDEEFFECT# co-write)
// 3. MANIFEST# rows keyed by version, never overwritten; full blob snapshotted at run-start
// 4. soft-budget continuation re-enqueues under same anchor
// 5. maxContinuations → DLQ guard against infinite loops
//
// Sub-step (mid-agent-loop) checkpointing is explicitly v2.
// v1 exactly-once contract is at the STEP boundary only.

export { drive, deriveRunId } from "./executor.js";
export type {
  ExecutorContext,
  ExecutorDeps,
  Queue,
  ToolsDispatcher,
  ApprovalsCoordinator,
} from "./executor.js";

export {
  MemoryStorage,
  MemoryQueue,
  MemoryBus,
  MemoryTenancy,
  FakeToolsDispatcher,
  FakeApprovalsCoordinator,
  LocalRuntime,
  createLocalRuntime,
} from "./runtime-local.js";
export type {
  ToolHandler,
  LocalRuntimeOptions,
} from "./runtime-local.js";

// P5 — AWS adapter implementations
export { DynamoStorage, DRAHT_TABLE_DEFINITION } from "./storage-dynamo.js";
export { EventBridgeBus } from "./event-eventbridge.js";
export {
  HttpChannel,
  encodeNdjsonLine,
  encodeNdjsonStream,
  buildHmacSignature,
} from "./channel-http.js";
export type { HttpChannelOptions, HttpParseResult } from "./channel-http.js";
export { SlackChannel, buildSlackSignature } from "./channel-slack.js";
export type { SlackChannelOptions } from "./channel-slack.js";
export { AwsRuntime } from "./runtime-aws.js";
export type { AwsRuntimeOptions } from "./runtime-aws.js";

// P6/v1.x — real tool execution + model resolution + per-agent executor factory
export { RealToolsDispatcher } from "./tools-dispatcher.js";
export type { ToolRegistry } from "./tools-dispatcher.js";
export { resolveModelFromEnv, resolveProvider } from "./resolve-model.js";
export type { ModelProvider } from "./resolve-model.js";
export { makeExecutorHandler } from "./handlers/make-executor.js";
export type { MakeExecutorOptions, ExecutorLambdaHandler } from "./handlers/make-executor.js";
