// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/ingress.ts — HTTP channel inbound Lambda handler.
 *
 * Routes:
 *   POST /v1/sessions         — inbound run trigger (verify + normalize + enqueue)
 *   GET  /v1/sessions/:id/stream — NDJSON streaming of run output
 *
 * The handler constructs HttpChannel from environment variables,
 * calls parse(), then submitRun via AwsRuntime.
 *
 * Environment variables:
 *   DRAHT_TABLE_NAME     — DynamoDB table name
 *   DRAHT_QUEUE_URL      — SQS queue URL
 *   DRAHT_MANIFEST_ID    — manifest agent ID
 *   DRAHT_MANIFEST_REV   — manifest revision
 *   DRAHT_CHANNEL_ID     — channel ID (default: "http-in")
 *   DRAHT_CHANNEL_AUTH   — "bearer:<token>" or "none" (default: "none")
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";

import type { TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";

import { DynamoStorage } from "../storage-dynamo.js";
import { AwsRuntime, deriveRunId } from "../runtime-aws.js";
import { HttpChannel, encodeNdjsonLine } from "../channel-http.js";
import type { HttpChannelOptions } from "../channel-http.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface APIGatewayEvent {
  httpMethod?: string;
  path?: string;
  pathParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface APIGatewayResult {
  statusCode: number;
  body: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// ingressHandler
// ---------------------------------------------------------------------------

export async function ingressHandler(
  event: APIGatewayEvent,
): Promise<APIGatewayResult> {
  const method = event.httpMethod ?? "POST";
  const path   = event.path ?? "";

  // Route: GET /v1/sessions/:id/stream
  if (method === "GET" && path.includes("/stream")) {
    return handleStream(event);
  }

  // Route: POST /v1/sessions
  return handleSubmit(event);
}

// ---------------------------------------------------------------------------
// POST /v1/sessions — normalize + submit
// ---------------------------------------------------------------------------

async function handleSubmit(event: APIGatewayEvent): Promise<APIGatewayResult> {
  const tableName   = process.env["DRAHT_TABLE_NAME"];
  const queueUrl    = process.env["DRAHT_QUEUE_URL"];
  const manifestId  = process.env["DRAHT_MANIFEST_ID"];
  const manifestRev = process.env["DRAHT_MANIFEST_REV"];
  const channelId   = process.env["DRAHT_CHANNEL_ID"] ?? "http-in";
  const channelAuth = process.env["DRAHT_CHANNEL_AUTH"] ?? "none";
  const tenantId    = (process.env["DRAHT_TENANT_ID"] ?? DEFAULT_TENANT) as TenantId;

  if (!tableName)   return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_TABLE_NAME required" }) };
  if (!queueUrl)    return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_QUEUE_URL required" }) };
  if (!manifestId)  return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_MANIFEST_ID required" }) };
  if (!manifestRev) return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_MANIFEST_REV required" }) };

  // Build HttpChannel from env config
  let channelOpts: HttpChannelOptions;
  if (channelAuth.startsWith("bearer:")) {
    channelOpts = { channelId, authType: "bearer", authToken: channelAuth.slice(7) };
  } else {
    channelOpts = { channelId, authType: "none" };
  }

  const channel = new HttpChannel(channelOpts);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers[k] = v;
  }

  const body      = event.body ?? "{}";
  const rawBody   = Buffer.from(body, event.isBase64Encoded ? "base64" : "utf-8");

  const parsed = await channel.parse({ headers, body: rawBody.toString("utf-8"), rawBody });

  if (parsed.kind === "reject") {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  if (parsed.kind === "ack") {
    return {
      statusCode: 200,
      body: JSON.stringify(parsed.response),
      headers: { "Content-Type": "application/json" },
    };
  }

  // kind === "run" — derive runId + submit
  const env = parsed.env;
  const dedupKey = (env.payload["dedupKey"] as string | undefined) ?? `http:${Date.now()}`;
  const runId    = deriveRunId(`http:${manifestId}`, dedupKey) as RunId;

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);
  const sqsClient = new SQSClient({});
  const runtime   = new AwsRuntime({ queueUrl, storage, client: sqsClient, tenantId });

  const result = await runtime.submitRun({
    runId,
    manifestId,
    manifestRevision: manifestRev,
    tenantId,
    trigger: { type: "webhook", dedupKey: dedupKey },
    input: env.payload,
    chainDepth: 0,
  });

  return {
    statusCode: 202,
    body: JSON.stringify({ runId, status: result.status }),
    headers: { "Content-Type": "application/json" },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/sessions/:id/stream — NDJSON stream
// ---------------------------------------------------------------------------

async function handleStream(event: APIGatewayEvent): Promise<APIGatewayResult> {
  const tableName = process.env["DRAHT_TABLE_NAME"];
  const tenantId  = (process.env["DRAHT_TENANT_ID"] ?? DEFAULT_TENANT) as TenantId;

  if (!tableName) {
    return { statusCode: 500, body: JSON.stringify({ error: "DRAHT_TABLE_NAME required" }) };
  }

  const runId = (event.pathParameters?.["id"] ?? "") as RunId;
  if (!runId) {
    return { statusCode: 400, body: JSON.stringify({ error: "runId path parameter required" }) };
  }

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const storage   = new DynamoStorage(tableName, ddbClient);

  const run = await storage.getRun(tenantId, runId);
  if (!run) {
    return { statusCode: 404, body: JSON.stringify({ error: `Run not found: ${runId}` }) };
  }

  // Return run status as NDJSON — for polling use case
  const lines = [
    encodeNdjsonLine({ type: "status", runId, status: run.status }),
    ...(run.steps.map((s) =>
      encodeNdjsonLine({ type: "step", stepId: s.stepId, status: s.status, output: s.output })
    )),
    encodeNdjsonLine({ type: "done" }),
  ];

  return {
    statusCode: 200,
    body: lines.join(""),
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  };
}
