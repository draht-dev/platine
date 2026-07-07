// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/deps.ts — shared Lambda-handler plumbing for the executor.
 *
 * Extracted so both the legacy `executorHandler` (StubToolsDispatcher +
 * NoopModel — v1: user tool code not bundled) and `makeExecutorHandler`
 * (RealToolsDispatcher + resolveModelFromEnv — the per-agent entry emitted by
 * `platine build`) share the EXACT same:
 *
 *   - SQS record parsing / drive()-per-record loop (driveRecords)
 *   - soft time-budget anchor (context.getRemainingTimeInMillis() - 3 minutes)
 *   - per-record error swallow (so one bad record doesn't poison the SQS batch)
 *   - AWS adapter construction (DynamoStorage + EventBridgeBus + SqsQueue +
 *     StorageApprovalsCoordinator + NoopTenancy) from env vars (buildAwsDeps)
 *
 * so the two handlers can't drift.
 *
 * SQS batchSize should be 1 for the executor (one run per Lambda invocation)
 * to avoid head-of-line blocking. The SST component configures this.
 */

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SQSClient } from "@aws-sdk/client-sqs";

import type { TenantId, RunId, ApprovalRow, Tenancy, Usage } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";

import {
  drive,
  type ExecutorContext,
  type ExecutorDeps,
  type Queue,
  type ApprovalsCoordinator,
} from "../executor.js";
import { DynamoStorage } from "../storage-dynamo.js";
import { EventBridgeBus } from "../event-eventbridge.js";

// ---------------------------------------------------------------------------
// Lambda handler types (subset of @types/aws-lambda)
// ---------------------------------------------------------------------------

export interface SQSRecord {
  body: string;
  messageAttributes?: Record<string, { dataType: string; stringValue?: string }>;
}

export interface SQSEvent {
  Records: SQSRecord[];
}

export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

// ---------------------------------------------------------------------------
// SQS Queue adapter — wraps SQSClient to implement the executor's Queue seam
// ---------------------------------------------------------------------------

export class SqsQueue implements Queue {
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
// StorageApprovalsCoordinator
// ---------------------------------------------------------------------------

export class StorageApprovalsCoordinator implements ApprovalsCoordinator {
  constructor(private readonly storage: DynamoStorage) {}

  async hold(params: {
    runId: RunId;
    tenantId: TenantId;
    nodeId: string;
    toolName: string;
    paramsJson: string;
    idempotencyKey: string;
  }): Promise<string> {
    // SECURITY FIX (CRITICAL 2): generate an unguessable actionId using
    // crypto.randomUUID() so that approval actionIds cannot be forged by an
    // attacker who knows the runId and nodeId (both of which are predictable).
    // The old scheme `action_${runId}_${nodeId}_${counter}` was fully computable
    // from public information and allowed unauthorized approval resolution.
    const actionId = `action_${randomUUID()}`;
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
// NoopTenancy
// ---------------------------------------------------------------------------

export class NoopTenancy implements Tenancy {
  async resolveTenant(): Promise<TenantId> { return DEFAULT_TENANT; }
  async checkQuota(_t: TenantId, _kind: "run"): Promise<{ allowed: boolean; used: number; limit: number; remaining: number }> {
    return { allowed: true, used: 0, limit: 99999, remaining: 99999 };
  }
  async recordUsage(_t: TenantId, _usage: Usage, _costUsd: number): Promise<void> {}
  async shouldBreak(_t: TenantId, _agentId: string): Promise<boolean> { return false; }
  async tripBreaker(_t: TenantId, _agentId: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// buildAwsDeps — construct the non-tools/non-model parts of ExecutorDeps
// from env vars. Shared by executorHandler and makeExecutorHandler.
// ---------------------------------------------------------------------------

export interface AwsBaseDeps {
  storage: DynamoStorage;
  eventBus: EventBridgeBus;
  queue: SqsQueue;
  tenancy: NoopTenancy;
  approvals: StorageApprovalsCoordinator;
}

export function buildAwsDeps(): AwsBaseDeps {
  const tableName = process.env["DRAHT_TABLE_NAME"];
  const busName   = process.env["DRAHT_BUS_NAME"] ?? "default";
  const queueUrl  = process.env["DRAHT_QUEUE_URL"];

  if (!tableName) throw new Error("DRAHT_TABLE_NAME env var is required");
  if (!queueUrl)  throw new Error("DRAHT_QUEUE_URL env var is required");

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);
  const eventBus  = new EventBridgeBus(busName, new EventBridgeClient({}));
  const queue     = new SqsQueue(new SQSClient({}), queueUrl);
  const tenancy   = new NoopTenancy();
  const approvals = new StorageApprovalsCoordinator(storage);

  return { storage, eventBus, queue, tenancy, approvals };
}

// ---------------------------------------------------------------------------
// driveRecords — shared SQS-record-loop: soft time budget + per-record
// drive() + error swallow (so one bad record doesn't poison the batch).
// ---------------------------------------------------------------------------

export async function driveRecords(
  event: SQSEvent,
  context: LambdaContext,
  deps: ExecutorDeps,
): Promise<void> {
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
