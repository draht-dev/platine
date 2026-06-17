// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/trigger.ts — EventBridge/schedule/webhook trigger handler.
 *
 * Normalizes incoming EventBridge events or schedule triggers into run envelopes.
 * Derives the deterministic runId at the boundary BEFORE enqueue.
 * Creates the RUN row via ensureRun (patch-not-create) + enqueues to SQS.
 *
 * Environment variables:
 *   DRAHT_TABLE_NAME      — DynamoDB table name
 *   DRAHT_QUEUE_URL       — SQS queue URL
 *   DRAHT_MANIFEST_ID     — manifest agent ID
 *   DRAHT_MANIFEST_REV    — manifest revision
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

import type { TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { TriggerEnvelope } from "@draht/core/seams";

import { DynamoStorage } from "../storage-dynamo.js";
import { deriveRunId } from "../executor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventBridgeEvent {
  source?: string;
  "detail-type"?: string;
  detail?: Record<string, unknown>;
  id?: string;
  time?: string;
}

interface ScheduledEvent {
  source?: string;
  "detail-type"?: "Scheduled Event";
  time?: string;
  id?: string;
}

// ---------------------------------------------------------------------------
// triggerHandler
// ---------------------------------------------------------------------------

export async function triggerHandler(
  event: EventBridgeEvent | ScheduledEvent,
): Promise<void> {
  const tableName  = process.env["DRAHT_TABLE_NAME"];
  const queueUrl   = process.env["DRAHT_QUEUE_URL"];
  const manifestId = process.env["DRAHT_MANIFEST_ID"];
  const manifestRev = process.env["DRAHT_MANIFEST_REV"];
  const tenantId   = (process.env["DRAHT_TENANT_ID"] ?? DEFAULT_TENANT) as TenantId;

  if (!tableName)   throw new Error("DRAHT_TABLE_NAME is required");
  if (!queueUrl)    throw new Error("DRAHT_QUEUE_URL is required");
  if (!manifestId)  throw new Error("DRAHT_MANIFEST_ID is required");
  if (!manifestRev) throw new Error("DRAHT_MANIFEST_REV is required");

  // Determine trigger type and build envelope
  const isScheduled = (event as ScheduledEvent)["detail-type"] === "Scheduled Event";
  const triggerSource = isScheduled
    ? `schedule:${manifestId}`
    : `event:${(event as EventBridgeEvent)["detail-type"] ?? "unknown"}`;

  const dedupKey = (event as EventBridgeEvent).id ?? `${triggerSource}:${Date.now()}`;

  // Deterministic runId — computed at boundary, BEFORE enqueue
  const runId = deriveRunId(triggerSource, dedupKey) as RunId;

  const trigger: TriggerEnvelope = isScheduled
    ? { type: "schedule" }
    : {
        type: "event",
        eventType: (event as EventBridgeEvent)["detail-type"] ?? "unknown",
        payload: (event as EventBridgeEvent).detail ?? {},
        dedupKey,
      };

  const input: Record<string, unknown> = (event as EventBridgeEvent).detail ?? {};

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);

  await storage.ensureRun({
    tenantId,
    runId,
    manifestId,
    manifestRevision: manifestRev,
  });

  // Seed the trigger input checkpoint
  await storage.appendCheckpoint({
    tenantId,
    runId,
    stepId: "__trigger__",
    status: "completed",
    output: { ...input, ...(trigger.payload ?? {}) },
  });

  // Enqueue to SQS
  const sqsClient = new SQSClient({});
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId,
        tenantId,
        continuationCount: 0,
        chainDepth: 0,
      }),
      MessageAttributes: {
        runId: { DataType: "String", StringValue: runId },
        continuationCount: { DataType: "Number", StringValue: "0" },
      },
    }),
  );

  console.log(`[trigger] enqueued runId=${runId} manifestId=${manifestId} rev=${manifestRev}`);
}
