// SPDX-License-Identifier: Apache-2.0
// @draht/runtime-aws — AWS serverless runtime stub (P4/P5 implement)
//
// Executor + AWS seam implementations:
//   - executor.ts: level scheduler, Engine-3 flush+drain, fan-out, approval gate
//   - storage-dynamo.ts: ElectroDB single-table, transactWrite step+sideeffect
//   - event-eventbridge.ts: EventBridge event bus
//   - channel-http.ts: HTTP channel (POST /v1/sessions, GET /v1/sessions/:id/stream NDJSON)
//   - channel-slack.ts: Slack inbound/outbound
//   - runtime-local.ts: MemoryStorage/Queue/Bus — SAME executor.ts behind seams (for `platine dev`)
//
// Key durability invariants (ALL greenfield — none exists in agent-studio reference):
// 1. deterministic runId at channel/trigger boundary BEFORE enqueue (never nanoid() in executor)
// 2. mandatory SIDEEFFECT# pre-check on every tool dispatch, co-written with step-completed
//    via ElectroDB transactWrite (verified available in 3.7.5)
// 3. MANIFEST# rows keyed by version, never overwritten; full blob snapshotted at run-start
// 4. SQS visibility timeout > Lambda timeout; soft-budget continuation re-enqueues under same anchor
// 5. maxContinuations → DLQ guard against infinite loops
//
// Sub-step (mid-agent-loop) checkpointing is explicitly v2.
// v1 exactly-once contract is at the STEP boundary only.

export {};
