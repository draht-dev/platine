// SPDX-License-Identifier: Apache-2.0
/**
 * storage-dynamo.ts — DynamoStorage implements Storage via DynamoDB single-table.
 *
 * Single-table layout (pk / sk namespace):
 *   pk=RUN#<runId>      sk=META                   → RunMeta row
 *   pk=RUN#<runId>      sk=STEP#<stepId>           → StepCheckpoint row
 *   pk=RUN#<runId>      sk=SIDEEFFECT#<nodeId>     → SideEffectRow (exactly-once ledger)
 *   pk=RUN#<runId>      sk=APPROVAL#<actionId>     → ApprovalRow
 *   pk=MANIFEST#<id>    sk=REV#<revision>          → full manifest blob (NEVER overwritten)
 *
 *   GSI1: gsi1pk = TENANT#<tenantId>  gsi1sk = STATUS#<status>#<createdAt>
 *         Allows dashboard queries by tenant + status.
 *
 * Key durability rules:
 * - ensureRun: patch-not-create (conditional put — if already exists, return existing)
 * - commitStepWithSideEffect: ONE TransactWrite (STEP + SIDEEFFECT) — atomic
 * - hasSideEffect: mandatory pre-check before any tool dispatch
 * - putManifest: written ONCE, never overwritten (conditional attribute_not_exists)
 * - setRunStatus: caller is responsible for draining flush chain before terminal writes
 *
 * Uses @aws-sdk/lib-dynamodb DocumentClient (constructor-injectable for tests).
 * No ElectroDB type gymnastics — raw SDK calls for full strict-mode TS compliance.
 */

import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CreateTableCommandInput } from "@aws-sdk/client-dynamodb";

import type { Storage } from "@draht/core/seams";
import type {
  TenantId,
  RunId,
  RunStatus,
  RunRecord,
  StepCheckpoint,
  SideEffectRow,
  ApprovalRow,
  Usage,
} from "@draht/core/seams";

// ---------------------------------------------------------------------------
// DynamoDB item shapes (raw attribute maps)
// ---------------------------------------------------------------------------

interface RunMetaItem {
  pk: string;
  sk: string;
  _entity: "RunMeta";
  tenantId: string;
  runId: string;
  manifestId: string;
  manifestRevision: string;
  status: string;
  chainDepth: number;
  attempt: number;
  continuations: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  error?: string;
  gsi1pk: string;
  gsi1sk: string;
  createdAt: string;
}

interface StepItem {
  pk: string;
  sk: string;
  _entity: "Step";
  tenantId: string;
  runId: string;
  stepId: string;
  status: string;
  inputJson?: string;
  outputJson?: string;
  idempotencyKey?: string;
  heldApprovalId?: string;
}

interface SideEffectItem {
  pk: string;
  sk: string;
  _entity: "SideEffect";
  tenantId: string;
  runId: string;
  nodeId: string;
  idempotencyKey: string;
  toolName: string;
  resultJson: string;
}

interface ApprovalItem {
  pk: string;
  sk: string;
  _entity: "Approval";
  actionId: string;
  runId: string;
  stepId: string;
  nodeId: string;
  toolName: string;
  paramsJson: string;
  status: string;
  idempotencyKey: string;
  decidedBy?: string;
}

interface ManifestItem {
  pk: string;
  sk: string;
  _entity: "Manifest";
  blob: string;
}

// ---------------------------------------------------------------------------
// DynamoStorage
// ---------------------------------------------------------------------------

export class DynamoStorage implements Storage {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  /**
   * @param tableName   — DynamoDB table name (single-table)
   * @param client      — DynamoDBDocumentClient (constructor-injectable for tests)
   */
  constructor(tableName: string, client: DynamoDBDocumentClient) {
    this.tableName = tableName;
    this.client    = client;
  }

  // ── PK/SK helpers ──────────────────────────────────────────────────────────

  private static runPk(runId: string): string        { return `RUN#${runId}`; }
  private static stepSk(stepId: string): string      { return `STEP#${stepId}`; }
  private static sideEffectSk(nodeId: string): string { return `SIDEEFFECT#${nodeId}`; }
  private static approvalSk(actionId: string): string { return `APPROVAL#${actionId}`; }
  private static manifestPk(manifestId: string): string { return `MANIFEST#${manifestId}`; }
  private static manifestSk(revision: string): string  { return `REV#${revision}`; }
  private static gsi1pk(tenantId: string): string    { return `TENANT#${tenantId}`; }
  private static gsi1sk(status: string, ts: string): string { return `STATUS#${status}#${ts}`; }

  // ── ensureRun ──────────────────────────────────────────────────────────────

  async ensureRun(r: {
    tenantId: TenantId;
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
  }): Promise<RunRecord> {
    const pk = DynamoStorage.runPk(r.runId);
    const sk = "META";

    // Fetch existing first (patch-not-create)
    const existing = await this.getItem<RunMetaItem>(pk, sk);
    if (existing !== null) {
      return this.metaToRecord(existing);
    }

    const now = new Date().toISOString();
    const item: RunMetaItem = {
      pk,
      sk,
      _entity: "RunMeta",
      tenantId: r.tenantId,
      runId: r.runId,
      manifestId: r.manifestId,
      manifestRevision: r.manifestRevision,
      status: "queued",
      chainDepth: 0,
      attempt: 1,
      continuations: 0,
      gsi1pk: DynamoStorage.gsi1pk(r.tenantId),
      gsi1sk: DynamoStorage.gsi1sk("queued", now),
      createdAt: now,
    };

    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (_err) {
      // Race: another writer created first — fetch and return
      const race = await this.getItem<RunMetaItem>(pk, sk);
      if (race !== null) return this.metaToRecord(race);
      throw _err;
    }

    return {
      tenantId: r.tenantId,
      runId: r.runId,
      manifestId: r.manifestId,
      manifestRevision: r.manifestRevision,
      status: "queued",
      chainDepth: 0,
      attempt: 1,
      continuations: 0,
      steps: [],
    };
  }

  // ── getRun ─────────────────────────────────────────────────────────────────

  async getRun(_t: TenantId, runId: RunId): Promise<RunRecord | null> {
    const pk = DynamoStorage.runPk(runId);

    const meta = await this.getItem<RunMetaItem>(pk, "META");
    if (meta === null) return null;

    // Query all STEP# rows for this run (sk begins_with "STEP#")
    const stepsResult = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skp)",
      ExpressionAttributeValues: { ":pk": pk, ":skp": "STEP#" },
    }));

    const steps: StepCheckpoint[] = (stepsResult.Items ?? []).map((item) => {
      const s = item as StepItem;
      const step: StepCheckpoint = {
        tenantId: s.tenantId as TenantId,
        runId: s.runId as RunId,
        stepId: s.stepId,
        status: s.status as StepCheckpoint["status"],
      };
      if (s.inputJson  !== undefined) step.input          = JSON.parse(s.inputJson) as Record<string, unknown>;
      if (s.outputJson !== undefined) step.output         = JSON.parse(s.outputJson) as unknown;
      if (s.idempotencyKey !== undefined) step.idempotencyKey = s.idempotencyKey;
      if (s.heldApprovalId !== undefined) step.heldApprovalId = s.heldApprovalId;
      return step;
    });

    return this.metaToRecord(meta, steps);
  }

  // ── loadStepOutputs ────────────────────────────────────────────────────────

  async loadStepOutputs(_t: TenantId, runId: RunId): Promise<Map<string, unknown>> {
    const pk = DynamoStorage.runPk(runId);
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skp)",
      ExpressionAttributeValues: { ":pk": pk, ":skp": "STEP#" },
    }));

    const map = new Map<string, unknown>();
    for (const item of result.Items ?? []) {
      const s = item as StepItem;
      if ((s.status === "completed" || s.status === "skipped") && s.outputJson !== undefined) {
        map.set(s.stepId, JSON.parse(s.outputJson) as unknown);
      }
    }
    return map;
  }

  // ── appendCheckpoint ───────────────────────────────────────────────────────

  async appendCheckpoint(c: StepCheckpoint): Promise<void> {
    const pk = DynamoStorage.runPk(c.runId);
    const sk = DynamoStorage.stepSk(String(c.stepId));
    const item: StepItem = {
      pk,
      sk,
      _entity: "Step",
      tenantId: c.tenantId,
      runId: c.runId,
      stepId: String(c.stepId),
      status: c.status,
    };
    if (c.input  !== undefined) item.inputJson        = JSON.stringify(c.input);
    if (c.output !== undefined) item.outputJson       = JSON.stringify(c.output);
    if (c.idempotencyKey !== undefined) item.idempotencyKey = c.idempotencyKey;
    if (c.heldApprovalId !== undefined) item.heldApprovalId = c.heldApprovalId;

    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  // ── commitStepWithSideEffect ───────────────────────────────────────────────

  /**
   * Atomic co-write of STEP#completed + SIDEEFFECT# via TransactWrite.
   * The core exactly-once guarantee at the step boundary.
   */
  async commitStepWithSideEffect(step: StepCheckpoint, ledger: SideEffectRow): Promise<void> {
    const stepPk = DynamoStorage.runPk(step.runId);
    const stepSk = DynamoStorage.stepSk(String(step.stepId));

    const stepItem: StepItem = {
      pk: stepPk,
      sk: stepSk,
      _entity: "Step",
      tenantId: step.tenantId,
      runId: step.runId,
      stepId: String(step.stepId),
      status: step.status,
    };
    if (step.input  !== undefined) stepItem.inputJson        = JSON.stringify(step.input);
    if (step.output !== undefined) stepItem.outputJson       = JSON.stringify(step.output);
    if (step.idempotencyKey !== undefined) stepItem.idempotencyKey = step.idempotencyKey;
    if (step.heldApprovalId !== undefined) stepItem.heldApprovalId = step.heldApprovalId;

    const sePk = DynamoStorage.runPk(ledger.runId);
    const seSk = DynamoStorage.sideEffectSk(ledger.nodeId);
    const seItem: SideEffectItem = {
      pk: sePk,
      sk: seSk,
      _entity: "SideEffect",
      tenantId: ledger.tenantId,
      runId: ledger.runId,
      nodeId: ledger.nodeId,
      idempotencyKey: ledger.idempotencyKey,
      toolName: ledger.toolName,
      resultJson: JSON.stringify(ledger.result),
    };

    const txInput: TransactWriteCommandInput = {
      TransactItems: [
        { Put: { TableName: this.tableName, Item: stepItem } },
        {
          Put: {
            TableName: this.tableName,
            Item: seItem,
            // Idempotent: if sideEffect already written, don't overwrite (first-write-wins)
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    };

    try {
      await this.client.send(new TransactWriteCommand(txInput));
    } catch (err) {
      // TransactionCanceledException with ConditionalCheckFailed on the sideEffect row
      // means the sideEffect was already written (idempotent). Still write the step.
      if (isTransactCancelledOnSideEffect(err)) {
        await this.client.send(new PutCommand({ TableName: this.tableName, Item: stepItem }));
        return;
      }
      throw err;
    }
  }

  // ── hasSideEffect ──────────────────────────────────────────────────────────

  async hasSideEffect(_t: TenantId, runId: RunId, nodeId: string): Promise<SideEffectRow | null> {
    const pk = DynamoStorage.runPk(runId);
    const sk = DynamoStorage.sideEffectSk(nodeId);
    const item = await this.getItem<SideEffectItem>(pk, sk);
    if (item === null) return null;
    return {
      tenantId: item.tenantId as TenantId,
      runId: item.runId as RunId,
      nodeId: item.nodeId,
      idempotencyKey: item.idempotencyKey,
      toolName: item.toolName,
      result: JSON.parse(item.resultJson) as unknown,
    };
  }

  // ── setRunStatus ───────────────────────────────────────────────────────────

  async setRunStatus(
    _t: TenantId,
    runId: RunId,
    status: RunStatus,
    fin: { usage?: Usage; costUsd?: number; error?: string },
  ): Promise<void> {
    const pk = DynamoStorage.runPk(runId);
    const sk = "META";
    const now = new Date().toISOString();

    // Fetch tenantId for GSI key derivation
    const existing = await this.getItem<RunMetaItem>(pk, sk);
    const tenantId = existing?.tenantId ?? "default";

    // Build UpdateExpression dynamically
    const setExprParts: string[] = [
      "#status = :status",
      "gsi1sk = :gsi1sk",
      "gsi1pk = :gsi1pk",
    ];
    const exprAttrNames: Record<string, string> = { "#status": "status" };
    const exprAttrValues: Record<string, unknown> = {
      ":status": status,
      ":gsi1sk": DynamoStorage.gsi1sk(status, now),
      ":gsi1pk": DynamoStorage.gsi1pk(tenantId),
    };

    if (fin.usage !== undefined) {
      setExprParts.push("inputTokens = :inputTokens", "outputTokens = :outputTokens");
      exprAttrValues[":inputTokens"]  = fin.usage.inputTokens;
      exprAttrValues[":outputTokens"] = fin.usage.outputTokens;
      if (fin.usage.cacheReadTokens !== undefined) {
        setExprParts.push("cacheReadTokens = :cacheReadTokens");
        exprAttrValues[":cacheReadTokens"] = fin.usage.cacheReadTokens;
      }
      if (fin.usage.cacheWriteTokens !== undefined) {
        setExprParts.push("cacheWriteTokens = :cacheWriteTokens");
        exprAttrValues[":cacheWriteTokens"] = fin.usage.cacheWriteTokens;
      }
    }
    if (fin.costUsd !== undefined) {
      setExprParts.push("costUsd = :costUsd");
      exprAttrValues[":costUsd"] = fin.costUsd;
    }
    if (fin.error !== undefined) {
      setExprParts.push("#error = :error");
      exprAttrNames["#error"] = "error";
      exprAttrValues[":error"] = fin.error;
    }

    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk, sk },
      UpdateExpression: `SET ${setExprParts.join(", ")}`,
      ExpressionAttributeNames: exprAttrNames,
      ExpressionAttributeValues: exprAttrValues,
    }));
  }

  // ── putManifest ────────────────────────────────────────────────────────────

  async putManifest(manifestId: string, revision: string, blob: string): Promise<void> {
    const pk = DynamoStorage.manifestPk(manifestId);
    const sk = DynamoStorage.manifestSk(revision);
    const item: ManifestItem = { pk, sk, _entity: "Manifest", blob };
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)", // never overwrite
      }));
    } catch (_err) {
      // Already exists — idempotent, ignore
    }
  }

  // ── loadManifest ───────────────────────────────────────────────────────────

  async loadManifest(manifestId: string, revision: string): Promise<string> {
    const pk = DynamoStorage.manifestPk(manifestId);
    const sk = DynamoStorage.manifestSk(revision);
    const item = await this.getItem<ManifestItem>(pk, sk);
    if (item === null) {
      throw new Error(`Manifest not found: ${manifestId}@${revision}`);
    }
    return item.blob;
  }

  // ── createPendingApproval ──────────────────────────────────────────────────

  async createPendingApproval(a: ApprovalRow): Promise<void> {
    const pk = DynamoStorage.runPk(a.runId);
    const sk = DynamoStorage.approvalSk(a.actionId);
    const item: ApprovalItem = {
      pk,
      sk,
      _entity: "Approval",
      actionId: a.actionId,
      runId: a.runId,
      stepId: a.stepId,
      nodeId: a.nodeId,
      toolName: a.toolName,
      paramsJson: a.paramsJson,
      status: a.status,
      idempotencyKey: a.idempotencyKey,
    };
    if (a.decidedBy !== undefined) item.decidedBy = a.decidedBy;
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      }));
    } catch (_err) {
      // Already exists — idempotent
    }
  }

  // ── resolveApproval ────────────────────────────────────────────────────────

  async resolveApproval(actionId: string, verdict: "approved" | "rejected"): Promise<void> {
    // Scan for the approval row by actionId attribute
    // (Infrequent operation — acceptable for v1; production should use a GSI on actionId)
    const scanResult = await this.client.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: "actionId = :actionId AND #ent = :entity",
      ExpressionAttributeNames: { "#ent": "_entity" },
      ExpressionAttributeValues: { ":actionId": actionId, ":entity": "Approval" },
    }));

    const row = (scanResult.Items ?? [])[0] as ApprovalItem | undefined;
    if (row === undefined) throw new Error(`Approval not found: ${actionId}`);
    if (row.status !== "pending") return; // first verdict wins

    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET #s = :verdict",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":verdict": verdict },
    }));
  }

  // ── getPendingByAction ─────────────────────────────────────────────────────

  async getPendingByAction(actionId: string): Promise<ApprovalRow | null> {
    const scanResult = await this.client.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: "actionId = :actionId AND #ent = :entity",
      ExpressionAttributeNames: { "#ent": "_entity" },
      ExpressionAttributeValues: { ":actionId": actionId, ":entity": "Approval" },
    }));

    const row = (scanResult.Items ?? [])[0] as ApprovalItem | undefined;
    if (row === undefined) return null;
    return this.approvalToRecord(row);
  }

  // ── getApprovalByStep ──────────────────────────────────────────────────────

  async getApprovalByStep(_t: TenantId, runId: RunId, nodeId: string): Promise<ApprovalRow | null> {
    const pk = DynamoStorage.runPk(runId);
    // Query all APPROVAL# rows for this run
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skp)",
      ExpressionAttributeValues: { ":pk": pk, ":skp": "APPROVAL#" },
    }));

    const rows = (result.Items ?? []).filter(
      (item) => (item as ApprovalItem).nodeId === nodeId
    ) as ApprovalItem[];
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    if (last === undefined) return null;
    return this.approvalToRecord(last);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getItem<T>(pk: string, sk: string): Promise<T | null> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk, sk },
    }));
    if (result.Item === undefined) return null;
    return result.Item as T;
  }

  private metaToRecord(meta: RunMetaItem, steps: StepCheckpoint[] = []): RunRecord {
    const record: RunRecord = {
      tenantId: meta.tenantId as TenantId,
      runId: meta.runId as RunId,
      manifestId: meta.manifestId,
      manifestRevision: meta.manifestRevision,
      status: meta.status as RunStatus,
      chainDepth: meta.chainDepth,
      attempt: meta.attempt,
      continuations: meta.continuations,
      steps,
    };
    if (meta.inputTokens !== undefined && meta.outputTokens !== undefined) {
      const usage: Usage = {
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
      };
      if (meta.cacheReadTokens  !== undefined) usage.cacheReadTokens  = meta.cacheReadTokens;
      if (meta.cacheWriteTokens !== undefined) usage.cacheWriteTokens = meta.cacheWriteTokens;
      record.usage = usage;
    }
    if (meta.costUsd !== undefined) record.costUsd = meta.costUsd;
    if (meta.error   !== undefined) record.error   = meta.error;
    return record;
  }

  private approvalToRecord(row: ApprovalItem): ApprovalRow {
    return {
      actionId: row.actionId,
      runId: row.runId as RunId,
      stepId: row.stepId,
      nodeId: row.nodeId,
      toolName: row.toolName,
      paramsJson: row.paramsJson,
      status: row.status as "pending" | "approved" | "rejected",
      idempotencyKey: row.idempotencyKey,
      ...(row.decidedBy !== undefined ? { decidedBy: row.decidedBy } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// TransactWrite error detection
// ---------------------------------------------------------------------------

function isTransactCancelledOnSideEffect(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (e["name"] !== "TransactionCanceledException") return false;
  const reasons = e["CancellationReasons"] as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(reasons)) return false;
  // TransactItems[0]=step (upsert, always OK), TransactItems[1]=sideEffect (create)
  // If the sideEffect put was cancelled with ConditionalCheckFailed → already exists → idempotent
  const seReason = reasons[1];
  return seReason?.["Code"] === "ConditionalCheckFailed";
}

// ---------------------------------------------------------------------------
// Table definition for provisioning (CloudFormation / CDK / SST)
// ---------------------------------------------------------------------------

/**
 * DRAHT_TABLE_DEFINITION — DynamoDB CreateTable parameters (spread into CreateTableCommand).
 * Key names match the AWS SDK v3 PascalCase CreateTableCommandInput interface.
 *
 * Usage:
 *   await client.send(new CreateTableCommand({ TableName: "...", ...DRAHT_TABLE_DEFINITION }));
 */
export const DRAHT_TABLE_DEFINITION: Omit<CreateTableCommandInput, "TableName"> = {
  AttributeDefinitions: [
    { AttributeName: "pk",     AttributeType: "S" },
    { AttributeName: "sk",     AttributeType: "S" },
    { AttributeName: "gsi1pk", AttributeType: "S" },
    { AttributeName: "gsi1sk", AttributeType: "S" },
  ],
  KeySchema: [
    { AttributeName: "pk", KeyType: "HASH"  },
    { AttributeName: "sk", KeyType: "RANGE" },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "gsi1",
      KeySchema: [
        { AttributeName: "gsi1pk", KeyType: "HASH"  },
        { AttributeName: "gsi1sk", KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    },
  ],
  BillingMode: "PAY_PER_REQUEST",
};
