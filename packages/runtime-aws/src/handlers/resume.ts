// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/resume.ts — ApprovalResume API handler.
 *
 * Handles POST /v1/runs/:runId/approve or POST /v1/runs/resume
 * with body: { actionId, decision: "approved"|"rejected", by? }
 *
 * Resolves the approval row, resets run status to "running", re-enqueues via SQS.
 * Returns a 200 OK with the updated run status.
 *
 * Environment variables:
 *   DRAHT_TABLE_NAME   — DynamoDB table name
 *   DRAHT_QUEUE_URL    — SQS queue URL
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";

import type { TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";

import { DynamoStorage } from "../storage-dynamo.js";
import { AwsRuntime } from "../runtime-aws.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface APIGatewayEvent {
  body?: string | null;
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
}

interface APIGatewayResult {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// resumeHandler
// ---------------------------------------------------------------------------

export async function resumeHandler(
  event: APIGatewayEvent,
): Promise<APIGatewayResult> {
  const tableName = process.env["DRAHT_TABLE_NAME"];
  const queueUrl  = process.env["DRAHT_QUEUE_URL"];
  const tenantId  = (process.env["DRAHT_TENANT_ID"] ?? DEFAULT_TENANT) as TenantId;

  if (!tableName) {
    return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_TABLE_NAME is required" }) };
  }
  if (!queueUrl) {
    return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_QUEUE_URL is required" }) };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? "{}") as Record<string, unknown>;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const actionId = body["actionId"];
  const decision = body["decision"];
  const by       = body["by"];
  const runId    = (event.pathParameters?.["runId"] ?? body["runId"]) as RunId | undefined;

  if (typeof actionId !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "actionId is required" }) };
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { statusCode: 400, body: JSON.stringify({ error: "decision must be 'approved' or 'rejected'" }) };
  }
  if (!runId) {
    return { statusCode: 400, body: JSON.stringify({ error: "runId is required (path param or body)" }) };
  }

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);
  const sqsClient = new SQSClient({});
  const runtime   = new AwsRuntime({ queueUrl, storage, client: sqsClient, tenantId });

  try {
    const result = await runtime.resumeRun({
      kind: "approval",
      runId,
      approvalId: actionId,
      decision,
      ...(typeof by === "string" ? { by } : {}),
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ runId, status: result.status }),
      headers: { "Content-Type": "application/json" },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { statusCode: 404, body: JSON.stringify({ error: msg }) };
  }
}
