// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/executor.ts — SQS-triggered Lambda handler for the executor loop.
 *
 * Wires: DynamoStorage + EventBridgeBus + AwsRuntime → drive()
 *
 * Each SQS record carries:
 *   { runId, tenantId, continuationCount, chainDepth }
 *
 * The handler constructs the Adapters bundle from environment variables and
 * invokes drive() for each record (via the shared driveRecords() in deps.ts).
 *
 * SQS batchSize should be 1 for the executor (one run per Lambda invocation)
 * to avoid head-of-line blocking. The SST component configures this.
 *
 * The soft time budget uses context.getRemainingTimeInMillis() - 3 minutes.
 * SQS visibility timeout MUST exceed the Lambda function timeout.
 */

import type { TenantId } from "@draht/core/seams";
import type { Model, ModelRequest, ModelStreamEvent } from "@draht/core/seams";
import type { ExecutorDeps, ToolsDispatcher } from "../executor.js";
import { buildAwsDeps, driveRecords, type SQSEvent, type LambdaContext } from "./deps.js";

// ---------------------------------------------------------------------------
// Stub implementation for tools (v1: local tools not supported via Lambda)
// ---------------------------------------------------------------------------

/**
 * v1 STUB dispatcher. The deployed executor runs the full DAG-scheduling +
 * checkpoint/resume + approval-gate machinery, but does NOT execute the
 * user's authored tool `execute()` code — this legacy handler is wired to a
 * FIXED module (@draht/runtime-aws/handlers) so user code is never bundled.
 * Agents that need real tool execution should use `platine build`'s emitted
 * `.platine/executor.entry.ts` (makeExecutorHandler in make-executor.ts),
 * which builds a RealToolsDispatcher from the agent's own WorkflowDef.
 * Tool BUSINESS LOGIC is not run here; tool RESULTS are stubbed.
 */
class StubToolsDispatcher implements ToolsDispatcher {
  async execute(toolRef: string, _input: Record<string, unknown>, _ctx: { idempotencyKey: string; tenantId: TenantId }): Promise<unknown> {
    console.warn(`[executor] STUB tool dispatch (v1: user tool code not bundled): ${toolRef} → {}`);
    return {};
  }
  hasSideEffect(_toolRef: string): boolean { return true; }
}

// ---------------------------------------------------------------------------
// NoopModel — placeholder (model is not used by tool/agent nodes via this
// legacy Lambda dispatch path; see makeExecutorHandler for the real adapter).
// ---------------------------------------------------------------------------

class NoopModel implements Model {
  stream(_req: ModelRequest, _signal?: AbortSignal): AsyncIterable<ModelStreamEvent> {
    throw new Error("[executor] model not configured in executor Lambda");
  }
  async chat(_req: ModelRequest, _signal?: AbortSignal): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    throw new Error("[executor] model not configured in executor Lambda");
  }
  supports(_modelId: string): boolean { return false; }
}

// ---------------------------------------------------------------------------
// executorHandler
// ---------------------------------------------------------------------------

export async function executorHandler(
  event: SQSEvent,
  context: LambdaContext,
): Promise<void> {
  const base = buildAwsDeps();
  const deps: ExecutorDeps = {
    ...base,
    model: new NoopModel(),
    tools: new StubToolsDispatcher(),
  };

  await driveRecords(event, context, deps);
}
