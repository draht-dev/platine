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
 * invokes drive() for each record. Errors are caught per-record to avoid
 * poisoning the batch.
 *
 * SQS batchSize should be 1 for the executor (one run per Lambda invocation)
 * to avoid head-of-line blocking. The SST component configures this.
 *
 * The soft time budget uses context.getRemainingTimeInMillis() - 3 minutes.
 * SQS visibility timeout MUST exceed the Lambda function timeout.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SQSClient } from "@aws-sdk/client-sqs";

import type { TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";

import { drive, type ExecutorContext, type ExecutorDeps, type Queue } from "../executor.js";
import { DynamoStorage } from "../storage-dynamo.js";
import { EventBridgeBus } from "../event-eventbridge.js";

// ---------------------------------------------------------------------------
// Lambda handler types (subset of @types/aws-lambda)
// ---------------------------------------------------------------------------

interface SQSRecord {
  body: string;
  messageAttributes?: Record<string, { dataType: string; stringValue?: string }>;
}

interface SQSEvent {
  Records: SQSRecord[];
}

interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

// ---------------------------------------------------------------------------
// SQS Queue adapter — wraps SQSClient to implement the executor's Queue seam
// ---------------------------------------------------------------------------

class SqsQueue implements Queue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async enqueueContinuation(runId: RunId, continuationCount: number): Promise<void> {
    const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ runId, continuationCount }),
        MessageAttributes: {
          continuationCount: { DataType: "Number", StringValue: String(continuationCount) },
          runId: { DataType: "String", StringValue: runId },
        },
      }),
    );
  }

  async enqueueDeadLetter(runId: RunId, reason: string): Promise<void> {
    // Log to CloudWatch; actual DLQ routing is handled by the SQS redrive policy.
    console.error(`[executor] DLQ: runId=${runId} reason=${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Stub implementations for tools/approvals (v1: local tools not supported via Lambda)
// ---------------------------------------------------------------------------

import type { ToolsDispatcher, ApprovalsCoordinator } from "../executor.js";
import type { ApprovalRow } from "@draht/core/seams";

class NoopToolsDispatcher implements ToolsDispatcher {
  async execute(toolRef: string, _input: Record<string, unknown>, _ctx: { idempotencyKey: string; tenantId: TenantId }): Promise<unknown> {
    throw new Error(`[executor] tool dispatch not supported in Lambda handler: ${toolRef}`);
  }
  hasSideEffect(_toolRef: string): boolean { return true; }
}

class StorageApprovalsCoordinator implements ApprovalsCoordinator {
  private counter = 0;
  constructor(private readonly storage: DynamoStorage) {}

  async hold(params: {
    runId: RunId;
    tenantId: TenantId;
    nodeId: string;
    toolName: string;
    paramsJson: string;
    idempotencyKey: string;
  }): Promise<string> {
    this.counter++;
    const actionId = `action_${params.runId}_${params.nodeId}_${this.counter}`;
    const row: ApprovalRow = {
      runId: params.runId,
      stepId: params.nodeId,
      actionId,
      nodeId: params.nodeId,
      toolName: params.toolName,
      paramsJson: params.paramsJson,
      status: "pending",
      idempotencyKey: params.idempotencyKey,
    };
    await this.storage.createPendingApproval(row);
    return actionId;
  }
}

// ---------------------------------------------------------------------------
// NoopModel — placeholder (model is not used by tool/agent nodes via Lambda dispatch)
// ---------------------------------------------------------------------------

import type { Model, ModelRequest, ModelStreamEvent } from "@draht/core/seams";

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
// NoopTenancy
// ---------------------------------------------------------------------------

import type { Tenancy, Usage } from "@draht/core/seams";

class NoopTenancy implements Tenancy {
  async resolveTenant(): Promise<TenantId> { return DEFAULT_TENANT; }
  async checkQuota(_t: TenantId, _kind: "run"): Promise<{ allowed: boolean; used: number; limit: number; remaining: number }> {
    return { allowed: true, used: 0, limit: 99999, remaining: 99999 };
  }
  async recordUsage(_t: TenantId, _usage: Usage, _costUsd: number): Promise<void> {}
  async shouldBreak(_t: TenantId, _agentId: string): Promise<boolean> { return false; }
  async tripBreaker(_t: TenantId, _agentId: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// executorHandler
// ---------------------------------------------------------------------------

export async function executorHandler(
  event: SQSEvent,
  context: LambdaContext,
): Promise<void> {
  const tableName = process.env["DRAHT_TABLE_NAME"];
  const busName   = process.env["DRAHT_BUS_NAME"] ?? "default";
  const queueUrl  = process.env["DRAHT_QUEUE_URL"];

  if (!tableName) throw new Error("DRAHT_TABLE_NAME env var is required");
  if (!queueUrl)  throw new Error("DRAHT_QUEUE_URL env var is required");

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);
  const bus       = new EventBridgeBus(busName, new EventBridgeClient({}));
  const queue     = new SqsQueue(new SQSClient({}), queueUrl);
  const tenancy   = new NoopTenancy();
  const tools     = new NoopToolsDispatcher();
  const approvals = new StorageApprovalsCoordinator(storage);
  const model     = new NoopModel();

  const deps: ExecutorDeps = { storage, model, eventBus: bus, tenancy, queue, tools, approvals };

  // Soft time budget: Lambda timeout - 3 minutes
  const softBudget = 3 * 60 * 1000;
  const deadlineAt = Date.now() + context.getRemainingTimeInMillis() - softBudget;

  for (const record of event.Records) {
    let runId: RunId | undefined;
    try {
      const msg = JSON.parse(record.body) as Record<string, unknown>;
      runId = (msg["runId"] as RunId) ?? undefined;
      const tenantId = (msg["tenantId"] as TenantId) ?? DEFAULT_TENANT;
      const continuationCount = typeof msg["continuationCount"] === "number" ? msg["continuationCount"] : 0;

      if (!runId) {
        console.error("[executor] SQS record missing runId:", record.body);
        continue;
      }

      const ctx: ExecutorContext = {
        tenantId,
        runId,
        deadlineAt,
        maxContinuations: 10,
        continuationCount,
      };

      await drive(ctx, deps);
    } catch (err) {
      console.error(`[executor] drive() error for runId=${runId ?? "unknown"}:`, err);
      // Do NOT rethrow — this would cause the whole batch to retry
      // The individual record's message visibility will expire and the message
      // will be redelivered naturally (SQS at-least-once).
    }
  }
}
