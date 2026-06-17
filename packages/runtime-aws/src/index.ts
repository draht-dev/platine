// SPDX-License-Identifier: Apache-2.0
// @draht/runtime-aws — AWS serverless runtime (P4 implements local executor; P5 adds AWS impls)
//
// Executor + in-memory seam implementations:
//   - executor.ts: level scheduler, Engine-3 flush+drain, fan-out, approval gate
//   - runtime-local.ts: MemoryStorage/Queue/Bus — SAME executor.ts behind seams (for `platine dev`)
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
