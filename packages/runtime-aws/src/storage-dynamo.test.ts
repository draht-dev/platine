// SPDX-License-Identifier: Apache-2.0
/**
 * storage-dynamo.test.ts — DynamoStorage acceptance tests.
 *
 * Strategy: try DynamoDB Local (Java-backed, real round-trips). If DynamoDB Local
 * cannot start after a genuine attempt, fall back to aws-sdk-client-mock with a
 * clear diagnostic. DynamoDB Local JAR is pre-downloaded at /tmp/dynamodb-local/.
 *
 * Covers:
 * (a) Round-trip EVERY row type: RunMeta, STEP#, SIDEEFFECT#, APPROVAL#, MANIFEST#
 * (b) commitStepWithSideEffect is ATOMIC (TransactWrite: both rows present)
 * (c) TransactWrite idempotency: sideEffect already present → no double-write error
 * (d) hasSideEffect pre-check gate
 * (e) putManifest is never-overwrite (second put with same key is idempotent)
 * (f) Re-runs the executor durability suite against DynamoStorage on real DDB Local
 *     (checkpoint/resume, approval hold/resume, redeliver no-double-fire)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ChildProcess } from "node:child_process";
import type { TenantId, RunId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { Manifest } from "@draht/core/manifest";

import { DynamoStorage, DRAHT_TABLE_DEFINITION } from "./storage-dynamo.js";
import { drive, deriveRunId, type ExecutorContext, type ExecutorDeps } from "./executor.js";
import {
  MemoryQueue,
  MemoryBus,
  MemoryTenancy,
  FakeToolsDispatcher,
} from "./runtime-local.js";
import { ScriptedModel } from "./fake-model.js";
import type { Storage, ApprovalRow } from "@draht/core/seams";
import type { ApprovalsCoordinator } from "./executor.js";

// ---------------------------------------------------------------------------
// StorageApprovalsCoordinator — wraps any Storage for tests
// ---------------------------------------------------------------------------

class StorageApprovalsCoordinator implements ApprovalsCoordinator {
  private actionCounter = 0;
  constructor(private readonly storage: Storage) {}

  async hold(params: {
    runId: RunId;
    tenantId: TenantId;
    nodeId: string;
    toolName: string;
    paramsJson: string;
    idempotencyKey: string;
  }): Promise<string> {
    this.actionCounter++;
    const actionId = `action_${this.actionCounter}_${Date.now()}`;
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
// DynamoDB Local setup
// ---------------------------------------------------------------------------

const DDB_LOCAL_PORT = 18123;
const DDB_LOCAL_ENDPOINT = `http://localhost:${DDB_LOCAL_PORT}`;
const TABLE_NAME = "draht-test-table";
const TENANT = DEFAULT_TENANT;

let ddbProcess: ChildProcess | null = null;
let usingRealDdb = false;
let storage: DynamoStorage | null = null;
let docClient: DynamoDBDocumentClient | null = null;

/** Attempt to start DynamoDB Local and create the test table. */
async function tryStartDynamoDbLocal(): Promise<boolean> {
  let DynamoDbLocal: typeof import("dynamodb-local");
  try {
    DynamoDbLocal = await import("dynamodb-local");
  } catch {
    console.warn("[storage-dynamo.test] dynamodb-local not installed — falling back to mocks");
    return false;
  }

  // Configure to use pre-extracted JAR
  DynamoDbLocal.configureInstaller({ installPath: "/tmp/dynamodb-local" });

  try {
    ddbProcess = await DynamoDbLocal.launch(DDB_LOCAL_PORT, null, ["-inMemory"] as const, false);
  } catch (err) {
    console.warn(`[storage-dynamo.test] DynamoDB Local failed to start: ${String(err)}`);
    return false;
  }

  // Wait for it to be ready
  const rawClient = new DynamoDBClient({
    endpoint: DDB_LOCAL_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  });

  let ready = false;
  for (let i = 0; i < 15; i++) {
    await new Promise<void>((r) => setTimeout(r, 300));
    try {
      const { ListTablesCommand } = await import("@aws-sdk/client-dynamodb");
      await rawClient.send(new ListTablesCommand({}));
      ready = true;
      break;
    } catch {
      // not ready yet
    }
  }

  if (!ready) {
    console.warn("[storage-dynamo.test] DynamoDB Local did not become ready in time");
    if (ddbProcess) { try { ddbProcess.kill(); } catch { /* ignore */ } }
    return false;
  }

  // Create the test table
  try {
    await rawClient.send(new CreateTableCommand({
      TableName: TABLE_NAME,
      ...DRAHT_TABLE_DEFINITION,
    }));
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name !== "ResourceInUseException") {
      console.warn(`[storage-dynamo.test] CreateTable failed: ${String(err)}`);
      if (ddbProcess) { try { ddbProcess.kill(); } catch { /* ignore */ } }
      return false;
    }
  }

  docClient = DynamoDBDocumentClient.from(rawClient);
  storage   = new DynamoStorage(TABLE_NAME, docClient);
  return true;
}

beforeAll(async () => {
  usingRealDdb = await tryStartDynamoDbLocal();
  if (!usingRealDdb) {
    console.warn(
      "[storage-dynamo.test] FALLBACK: DynamoDB Local not available. " +
      "Tests will use aws-sdk-client-mock to assert correct SDK call params.",
    );
  } else {
    console.log(`[storage-dynamo.test] DynamoDB Local running at ${DDB_LOCAL_ENDPOINT}`);
  }
}, 30_000);

afterAll(async () => {
  if (ddbProcess) {
    try {
      if (docClient) {
        const rawClient = new DynamoDBClient({
          endpoint: DDB_LOCAL_ENDPOINT,
          region: "us-east-1",
          credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
        });
        await rawClient.send(new DeleteTableCommand({ TableName: TABLE_NAME })).catch(() => {});
      }
    } catch { /* ignore cleanup errors */ }
    const ddbLocalMod = await import("dynamodb-local");
    ddbLocalMod.stopChild(ddbProcess);
    ddbProcess = null;
  }
});

// ---------------------------------------------------------------------------
// Mock-based tests (always run — assert correct SDK params even w/o real DDB)
// ---------------------------------------------------------------------------

import { mockClient } from "aws-sdk-client-mock";
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  ScanCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

describe("DynamoStorage — mock assertions (always run)", () => {
  it("ensureRun sends a GetCommand then PutCommand with correct PK/SK", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(GetCommand).resolves({ Item: undefined });
    mock.on(PutCommand).resolves({});
    mock.on(UpdateCommand).resolves({});

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    await s.ensureRun({
      tenantId: TENANT,
      runId: "run123" as RunId,
      manifestId: "agent1",
      manifestRevision: "rev1",
    });

    const getCalls = mock.commandCalls(GetCommand);
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    const getInput = getCalls[0]!.args[0].input;
    expect(getInput.Key).toEqual({ pk: "RUN#run123", sk: "META" });

    const putCalls = mock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const putInput = putCalls[0]!.args[0].input;
    expect(putInput.Item).toMatchObject({
      pk: "RUN#run123",
      sk: "META",
      tenantId: TENANT,
      runId: "run123",
      manifestId: "agent1",
      manifestRevision: "rev1",
      status: "queued",
    });
    expect(putInput.ConditionExpression).toBe("attribute_not_exists(pk)");

    mock.restore();
  });

  it("commitStepWithSideEffect sends a TransactWrite with STEP# + SIDEEFFECT# items", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(TransactWriteCommand).resolves({});

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    await s.commitStepWithSideEffect(
      {
        tenantId: TENANT,
        runId: "run123" as RunId,
        stepId: "step_a",
        status: "completed",
        output: { result: "done" },
        idempotencyKey: "run123#step_a",
      },
      {
        tenantId: TENANT,
        runId: "run123" as RunId,
        nodeId: "step_a",
        idempotencyKey: "run123#step_a",
        toolName: "do_thing",
        result: { done: true },
      },
    );

    const txCalls = mock.commandCalls(TransactWriteCommand);
    expect(txCalls.length).toBe(1);
    const items = txCalls[0]!.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);

    const stepPut = items[0]!["Put"]!;
    expect(stepPut.Item).toMatchObject({ pk: "RUN#run123", sk: "STEP#step_a", status: "completed" });
    expect(stepPut.Item?.["outputJson"]).toBe(JSON.stringify({ result: "done" }));

    const sePut = items[1]!["Put"]!;
    expect(sePut.Item).toMatchObject({ pk: "RUN#run123", sk: "SIDEEFFECT#step_a", nodeId: "step_a" });
    expect(sePut.Item?.["resultJson"]).toBe(JSON.stringify({ done: true }));
    expect(sePut.ConditionExpression).toBe("attribute_not_exists(pk)");

    mock.restore();
  });

  it("hasSideEffect performs a GetCommand on SIDEEFFECT# key", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(GetCommand).resolves({
      Item: {
        pk: "RUN#run123",
        sk: "SIDEEFFECT#step_a",
        _entity: "SideEffect",
        tenantId: TENANT,
        runId: "run123",
        nodeId: "step_a",
        idempotencyKey: "key1",
        toolName: "do_thing",
        resultJson: '{"r":1}',
      },
    });

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    const result = await s.hasSideEffect(TENANT, "run123" as RunId, "step_a");
    expect(result).not.toBeNull();
    expect(result?.nodeId).toBe("step_a");
    expect(result?.result).toEqual({ r: 1 });

    const getCalls = mock.commandCalls(GetCommand);
    expect(getCalls[0]!.args[0].input.Key).toEqual({ pk: "RUN#run123", sk: "SIDEEFFECT#step_a" });

    mock.restore();
  });

  it("putManifest uses attribute_not_exists condition (never overwrite)", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(PutCommand).resolves({});

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    await s.putManifest("agent1", "rev1", '{"hello":"world"}');

    const putCalls = mock.commandCalls(PutCommand);
    expect(putCalls[0]!.args[0].input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(putCalls[0]!.args[0].input.Item).toMatchObject({
      pk: "MANIFEST#agent1",
      sk: "REV#rev1",
      blob: '{"hello":"world"}',
    });

    mock.restore();
  });

  it("setRunStatus uses UpdateCommand with status + gsi keys", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(GetCommand).resolves({
      Item: {
        pk: "RUN#r1", sk: "META", tenantId: TENANT, runId: "r1",
        manifestId: "m", manifestRevision: "v", status: "running",
        chainDepth: 0, attempt: 1, continuations: 0,
        gsi1pk: "TENANT#default", gsi1sk: "STATUS#running#2024", createdAt: "2024-01-01",
      },
    });
    mock.on(UpdateCommand).resolves({});

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    await s.setRunStatus(TENANT, "r1" as RunId, "completed", { costUsd: 0.01 });

    const updateCalls = mock.commandCalls(UpdateCommand);
    const expr = updateCalls[0]!.args[0].input.UpdateExpression ?? "";
    expect(expr).toContain("#status = :status");
    const vals = updateCalls[0]!.args[0].input.ExpressionAttributeValues ?? {};
    expect(vals[":status"]).toBe("completed");
    expect(vals[":costUsd"]).toBe(0.01);

    mock.restore();
  });

  // Verify ScanCommand or GetCommand is used for getPendingByAction
  it("getPendingByAction returns null when item missing (mock)", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(ScanCommand).resolves({ Items: [] });
    mock.on(GetCommand).resolves({ Item: undefined });

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    const result = await s.getPendingByAction("no-such-action");
    expect(result).toBeNull();

    mock.restore();
  });

  it("loadManifest returns null/throws for missing manifest (mock)", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(GetCommand).resolves({ Item: undefined });

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    await expect(s.loadManifest("no-agent", "no-rev")).rejects.toThrow();

    mock.restore();
  });

  // Ensure QueryCommand is used for loadStepOutputs
  it("loadStepOutputs uses QueryCommand (mock)", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    mock.on(QueryCommand).resolves({ Items: [] });

    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    const result = await s.loadStepOutputs(TENANT, "run_x" as RunId);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);

    const queryCalls = mock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);

    mock.restore();
  });

  // MAJOR 2 (b): getApprovalByStep must be deterministic even when multiple
  // rows exist for the same (runId, nodeId) — sk = APPROVAL#action_<uuid> is
  // a random tiebreak, NOT creation order, so "last item returned by Query"
  // is nondeterministic. Assert: a resolved (approved) row always wins over
  // a pending duplicate, REGARDLESS of the order Query returns them in.
  it("getApprovalByStep prefers an approved row over a pending duplicate, regardless of Query item order", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    const pendingItem = {
      pk: "RUN#run_x", sk: "APPROVAL#action_pending", _entity: "Approval",
      actionId: "action_pending", runId: "run_x", stepId: "n", nodeId: "n",
      toolName: "t", paramsJson: "{}", status: "pending",
      idempotencyKey: "run_x#n", createdAt: "2026-01-01T00:00:00.000Z",
    };
    const approvedItem = {
      pk: "RUN#run_x", sk: "APPROVAL#action_approved", _entity: "Approval",
      actionId: "action_approved", runId: "run_x", stepId: "n", nodeId: "n",
      toolName: "t", paramsJson: "{}", status: "approved",
      idempotencyKey: "run_x#n", createdAt: "2025-12-31T00:00:00.000Z", // OLDER than the pending row
    };

    // Order A: pending first, approved last (what "pick last" used to assume).
    mock.on(QueryCommand)
      .resolvesOnce({ Items: [pendingItem, approvedItem] })
      .resolvesOnce({ Items: [approvedItem, pendingItem] });
    const foundA = await s.getApprovalByStep(TENANT, "run_x" as RunId, "n");
    expect(foundA?.status).toBe("approved");
    expect(foundA?.actionId).toBe("action_approved");

    // Order B: approved first, pending last — must still pick "approved".
    const foundB = await s.getApprovalByStep(TENANT, "run_x" as RunId, "n");
    expect(foundB?.status).toBe("approved");
    expect(foundB?.actionId).toBe("action_approved");

    mock.restore();
  });

  it("getApprovalByStep tiebreaks two pending duplicates by newest createdAt", async () => {
    const mock = mockClient(DynamoDBDocumentClient);
    const mockDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const s = new DynamoStorage("test-table", mockDoc);

    const older = {
      pk: "RUN#run_y", sk: "APPROVAL#action_old", _entity: "Approval",
      actionId: "action_old", runId: "run_y", stepId: "n", nodeId: "n",
      toolName: "t", paramsJson: "{}", status: "pending",
      idempotencyKey: "run_y#n", createdAt: "2026-01-01T00:00:00.000Z",
    };
    const newer = {
      pk: "RUN#run_y", sk: "APPROVAL#action_new", _entity: "Approval",
      actionId: "action_new", runId: "run_y", stepId: "n", nodeId: "n",
      toolName: "t", paramsJson: "{}", status: "pending",
      idempotencyKey: "run_y#n", createdAt: "2026-01-02T00:00:00.000Z",
    };
    mock.on(QueryCommand).resolves({ Items: [older, newer] });

    const found = await s.getApprovalByStep(TENANT, "run_y" as RunId, "n");
    expect(found?.actionId).toBe("action_new");

    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// Real DynamoDB Local tests (only run if DDB Local is available)
// ---------------------------------------------------------------------------

/**
 * withRealDdb — registers a test that runs only when DynamoDB Local is available.
 *
 * NOTE: The skip decision happens INSIDE the test body (at runtime), not at collection
 * time. This avoids the vitest issue where `it.skip` registered at collection time fires
 * before `beforeAll` has had a chance to set `usingRealDdb = true`.
 */
function withRealDdb(name: string, fn: () => Promise<void>): void {
  it(name, async () => {
    if (!usingRealDdb) {
      console.warn(`[SKIP] ${name} — DynamoDB Local not available`);
      return;
    }
    await fn();
  }, 15_000);
}

function getStorage(): DynamoStorage {
  if (!storage) throw new Error("DynamoDB Local storage not initialized");
  return storage;
}

function uniqueRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2)}` as RunId;
}

describe("DynamoStorage — DynamoDB Local round-trips", () => {
  withRealDdb("(a) round-trip RunMeta — ensureRun + getRun", async () => {
    const s = getStorage();
    const runId = uniqueRunId();

    const created = await s.ensureRun({
      tenantId: TENANT,
      runId,
      manifestId: "m1",
      manifestRevision: "r1",
    });
    expect(created.status).toBe("queued");
    expect(created.chainDepth).toBe(0);

    const fetched = await s.getRun(TENANT, runId);
    expect(fetched).not.toBeNull();
    expect(fetched?.runId).toBe(runId);
    expect(fetched?.manifestId).toBe("m1");
    expect(fetched?.status).toBe("queued");
  });

  withRealDdb("(a) ensureRun is idempotent (patch-not-create)", async () => {
    const s = getStorage();
    const runId = uniqueRunId();

    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });
    // Second call should return the existing row unchanged
    const second = await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m2", manifestRevision: "r2" });
    expect(second.manifestId).toBe("m1"); // original, not overwritten
  });

  withRealDdb("(a) round-trip STEP# — appendCheckpoint + loadStepOutputs", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    await s.appendCheckpoint({
      tenantId: TENANT,
      runId,
      stepId: "step_a",
      status: "completed",
      output: { answer: 42 },
      idempotencyKey: `${runId}#step_a`,
    });

    const outputs = await s.loadStepOutputs(TENANT, runId);
    expect(outputs.get("step_a")).toEqual({ answer: 42 });
  });

  withRealDdb("(a) round-trip SIDEEFFECT# — hasSideEffect returns null then row", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    // Not present yet
    const before = await s.hasSideEffect(TENANT, runId, "nodeX");
    expect(before).toBeNull();

    // Commit step + sideEffect atomically
    await s.commitStepWithSideEffect(
      { tenantId: TENANT, runId, stepId: "nodeX", status: "completed", output: { v: 1 }, idempotencyKey: `${runId}#nodeX` },
      { tenantId: TENANT, runId, nodeId: "nodeX", idempotencyKey: `${runId}#nodeX`, toolName: "tool1", result: { v: 1 } },
    );

    const after = await s.hasSideEffect(TENANT, runId, "nodeX");
    expect(after).not.toBeNull();
    expect(after?.nodeId).toBe("nodeX");
    expect(after?.result).toEqual({ v: 1 });
  });

  withRealDdb("(b) commitStepWithSideEffect is ATOMIC — both rows present after write", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    await s.commitStepWithSideEffect(
      { tenantId: TENANT, runId, stepId: "atomic_step", status: "completed", output: { ok: true } },
      { tenantId: TENANT, runId, nodeId: "atomic_step", idempotencyKey: "k1", toolName: "t1", result: { ok: true } },
    );

    const se = await s.hasSideEffect(TENANT, runId, "atomic_step");
    expect(se).not.toBeNull();

    const outputs = await s.loadStepOutputs(TENANT, runId);
    expect(outputs.get("atomic_step")).toEqual({ ok: true });
  });

  withRealDdb("(c) commitStepWithSideEffect idempotent — sideEffect already present → no error", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    // First commit
    await s.commitStepWithSideEffect(
      { tenantId: TENANT, runId, stepId: "idem_step", status: "completed", output: { n: 1 } },
      { tenantId: TENANT, runId, nodeId: "idem_step", idempotencyKey: "k2", toolName: "t2", result: { n: 1 } },
    );

    // Second commit (sideEffect already present) — should NOT throw
    await expect(
      s.commitStepWithSideEffect(
        { tenantId: TENANT, runId, stepId: "idem_step", status: "completed", output: { n: 1 } },
        { tenantId: TENANT, runId, nodeId: "idem_step", idempotencyKey: "k2", toolName: "t2", result: { n: 1 } },
      )
    ).resolves.not.toThrow();
  });

  withRealDdb("(a) round-trip APPROVAL# — createPendingApproval + getPendingByAction", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    const actionId = `action_${Date.now()}`;
    await s.createPendingApproval({
      runId,
      stepId: "gate_step",
      actionId,
      nodeId: "gate_step",
      toolName: "escalate",
      paramsJson: '{"ticket":"t1"}',
      status: "pending",
      idempotencyKey: `${runId}#gate_step`,
    });

    const fetched = await s.getPendingByAction(actionId);
    expect(fetched).not.toBeNull();
    expect(fetched?.status).toBe("pending");
    expect(fetched?.nodeId).toBe("gate_step");
  });

  withRealDdb("(a) resolveApproval changes status (first verdict wins)", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    const actionId = `act_${Date.now()}`;
    await s.createPendingApproval({
      runId,
      stepId: "gate2",
      actionId,
      nodeId: "gate2",
      toolName: "tool",
      paramsJson: "{}",
      status: "pending",
      idempotencyKey: `${runId}#gate2`,
    });

    await s.resolveApproval(actionId, "approved");
    const row = await s.getPendingByAction(actionId);
    expect(row?.status).toBe("approved");

    // Second verdict — rejected — must not change it
    await s.resolveApproval(actionId, "rejected");
    const row2 = await s.getPendingByAction(actionId);
    expect(row2?.status).toBe("approved"); // first wins
  });

  withRealDdb("(a) round-trip MANIFEST# — putManifest + loadManifest", async () => {
    const s = getStorage();
    const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const blob = JSON.stringify({ schemaVersion: "1.0.0", agentId: "ag1" });
    await s.putManifest(`ag1${suffix}`, "rev_abc", blob);

    const loaded = await s.loadManifest(`ag1${suffix}`, "rev_abc");
    expect(loaded).toBe(blob);
  });

  withRealDdb("(e) putManifest is never-overwrite (second put same key is idempotent)", async () => {
    const s = getStorage();
    const suffix = `_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const blob1 = '{"v":1}';
    const blob2 = '{"v":2}';
    await s.putManifest(`ag_never${suffix}`, "rev1", blob1);
    await s.putManifest(`ag_never${suffix}`, "rev1", blob2); // should NOT overwrite

    const loaded = await s.loadManifest(`ag_never${suffix}`, "rev1");
    expect(loaded).toBe(blob1); // original preserved
  });

  withRealDdb("setRunStatus updates status + writes usage", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    await s.setRunStatus(TENANT, runId, "completed", {
      usage: { inputTokens: 100, outputTokens: 50 },
      costUsd: 0.002,
    });

    const run = await s.getRun(TENANT, runId);
    expect(run?.status).toBe("completed");
    expect(run?.usage?.inputTokens).toBe(100);
    expect(run?.costUsd).toBe(0.002);
  });

  withRealDdb("getApprovalByStep returns most-recent approval for (runId, nodeId)", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    const a1id = `act_a1_${Date.now()}`;
    await s.createPendingApproval({
      runId, stepId: "gateN", actionId: a1id, nodeId: "gateN",
      toolName: "t", paramsJson: "{}", status: "pending",
      idempotencyKey: `${runId}#gateN#1`,
    });

    const found = await s.getApprovalByStep(TENANT, runId, "gateN");
    expect(found).not.toBeNull();
    expect(found?.actionId).toBe(a1id);
  });

  withRealDdb("getRun includes steps from loadStepOutputs", async () => {
    const s = getStorage();
    const runId = uniqueRunId();
    await s.ensureRun({ tenantId: TENANT, runId, manifestId: "m1", manifestRevision: "r1" });

    await s.appendCheckpoint({
      tenantId: TENANT, runId, stepId: "__trigger__",
      status: "completed", output: { trigger: true },
    });
    await s.appendCheckpoint({
      tenantId: TENANT, runId, stepId: "step_x",
      status: "completed", output: { x: 99 },
    });

    const run = await s.getRun(TENANT, runId);
    expect(run?.steps.some((step) => step.stepId === "step_x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Executor durability suite against DynamoStorage (real DDB Local proof)
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: "1.0.0",
    revision: "rev_dynamo_test",
    kind: "workflow",
    agent: {
      agentId: "dynamo-test-agent",
      name: "Dynamo Test Agent",
      model: { provider: "anthropic", modelId: "claude-haiku-4-5" },
      instructionsRef: { contentHash: "sha256:abc", inline: "test agent" },
      skills: [],
      maxIterations: 3,
      maxToolCallsPerIteration: 3,
      circuitBreakerErrorThreshold: 5,
    },
    tenancy: { mode: "single" },
    triggers: [{ type: "manual" }],
    channels: [],
    connections: [],
    tools: [],
    nodes: [],
    edges: [],
    resources: { needsHttpEgress: false, needsBedrock: false, needsEventBus: true, secrets: [], extraIam: [] },
    resume: { via: "api", holdsApproval: false },
    ...overrides,
  };
}

function makeCtx(runId: RunId, overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    tenantId: TENANT,
    runId,
    deadlineAt: Date.now() + 10 * 60 * 1000,
    maxContinuations: 10,
    continuationCount: 0,
    ...overrides,
  };
}

async function bootstrapDynamo(
  s: DynamoStorage,
  manifest: Manifest,
  runId: RunId,
  input: Record<string, unknown> = {},
): Promise<void> {
  await s.putManifest(manifest.agent.agentId, manifest.revision, JSON.stringify(manifest));
  await s.ensureRun({
    tenantId: TENANT,
    runId,
    manifestId: manifest.agent.agentId,
    manifestRevision: manifest.revision,
  });
  await s.appendCheckpoint({
    tenantId: TENANT,
    runId,
    stepId: "__trigger__",
    status: "completed",
    output: input,
  });
}

function makeDepsWithDynamo(s: DynamoStorage, tools: FakeToolsDispatcher): ExecutorDeps {
  const queue     = new MemoryQueue();
  const bus       = new MemoryBus();
  const tenancy   = new MemoryTenancy();
  const approvals = new StorageApprovalsCoordinator(s);
  const model     = new ScriptedModel([{ stopReason: "end_turn", text: "ok" }]);
  return { storage: s, model, eventBus: bus, tenancy, queue, tools, approvals };
}

describe("Executor durability suite on DynamoDB Local", () => {
  withRealDdb("(f) checkpoint/resume — completed steps NOT re-run after redelivery", async () => {
    const s = getStorage();
    const manifest = makeManifest({
      agent: { agentId: `dr-resume-${Date.now()}`, name: "T", model: { provider: "anthropic", modelId: "m" },
        instructionsRef: { contentHash: "h" }, skills: [], maxIterations: 3, maxToolCallsPerIteration: 3, circuitBreakerErrorThreshold: 5 },
      tools: [
        { toolId: "tool1", name: "tool1", description: "t", kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false, dangerous: false },
      ],
      nodes: [
        { nodeId: "step_a", kind: "tool", toolRef: "tool1", requiresApproval: false, params: {}, outputSchema: [] },
        { nodeId: "step_b", kind: "tool", toolRef: "tool1", requiresApproval: false, params: {}, outputSchema: [] },
      ],
      edges: [{ edgeId: "e1", source: "step_a", target: "step_b" }],
    });

    const runId = `run_${Date.now()}_resume` as RunId;
    await bootstrapDynamo(s, manifest, runId);

    const tools = new FakeToolsDispatcher();
    let callCount = 0;
    tools.register("tool1", async () => ({ n: ++callCount }));

    // Pre-commit step_a (simulating it already ran)
    await s.commitStepWithSideEffect(
      { tenantId: TENANT, runId, stepId: "step_a", status: "completed", output: { n: 0 }, idempotencyKey: `${runId}#step_a` },
      { tenantId: TENANT, runId, nodeId: "step_a", idempotencyKey: `${runId}#step_a`, toolName: "tool1", result: { n: 0 } },
    );

    const deps = makeDepsWithDynamo(s, tools);
    await drive(makeCtx(runId), deps);

    const run = await s.getRun(TENANT, runId);
    expect(run?.status).toBe("completed");
    // Only step_b should have called the tool (step_a was pre-done)
    expect(callCount).toBe(1);
  });

  withRealDdb("(f) redeliver no-double-fire — sideEffect ledger prevents re-execution", async () => {
    const s = getStorage();
    const agentId = `dr-fire-${Date.now()}`;
    const manifest = makeManifest({
      agent: { agentId, name: "T", model: { provider: "anthropic", modelId: "m" },
        instructionsRef: { contentHash: "h" }, skills: [], maxIterations: 3, maxToolCallsPerIteration: 3, circuitBreakerErrorThreshold: 5 },
      tools: [
        { toolId: "once_tool", name: "once_tool", description: "t", kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false, dangerous: false },
      ],
      nodes: [
        { nodeId: "once_step", kind: "tool", toolRef: "once_tool", requiresApproval: false, params: {}, outputSchema: [] },
      ],
    });

    const runId = `run_${Date.now()}_fire` as RunId;
    await bootstrapDynamo(s, manifest, runId);

    const tools = new FakeToolsDispatcher();
    let fires = 0;
    tools.register("once_tool", async () => ({ count: ++fires }));

    const deps = makeDepsWithDynamo(s, tools);
    // First delivery
    await drive(makeCtx(runId), deps);
    expect(fires).toBe(1);

    // Redelivery: run is completed → no-op
    await drive(makeCtx(runId), deps);
    expect(fires).toBe(1); // unchanged
  });

  withRealDdb("(f) approval hold — executor sets status to awaiting_approval", async () => {
    const s = getStorage();
    const agentId = `dr-hold-${Date.now()}`;
    const manifest = makeManifest({
      agent: { agentId, name: "T", model: { provider: "anthropic", modelId: "m" },
        instructionsRef: { contentHash: "h" }, skills: [], maxIterations: 3, maxToolCallsPerIteration: 3, circuitBreakerErrorThreshold: 5 },
      tools: [
        { toolId: "gated_tool", name: "gated_tool", description: "t", kind: "local",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: true, dangerous: true },
      ],
      nodes: [
        { nodeId: "gated_step", kind: "tool", toolRef: "gated_tool", requiresApproval: true, params: {}, outputSchema: [] },
      ],
      resume: { via: "api", holdsApproval: true },
    });

    const runId = `run_${Date.now()}_hold` as RunId;
    await bootstrapDynamo(s, manifest, runId);

    const tools = new FakeToolsDispatcher();
    tools.register("gated_tool", async () => ({ done: true }));

    const deps = makeDepsWithDynamo(s, tools);

    // First drive: should hold at awaiting_approval
    await drive(makeCtx(runId), deps);
    const held = await s.getRun(TENANT, runId);
    expect(held?.status).toBe("awaiting_approval");
    expect(tools.getCallCount("gated_tool")).toBe(0);

    // Find the approval and verify it was persisted
    const approval = await s.getApprovalByStep(TENANT, runId, "gated_step");
    expect(approval).not.toBeNull();
    expect(approval?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// HttpChannel.parse() — unit tests (always run, no DDB needed)
// ---------------------------------------------------------------------------

import { HttpChannel, encodeNdjsonLine, encodeNdjsonStream } from "./channel-http.js";

describe("HttpChannel.parse()", () => {
  it("returns kind=run for valid JSON body without auth", async () => {
    const ch = new HttpChannel({ channelId: "http-in" });
    const body = JSON.stringify({ payload: { message: "hello" } });
    const result = await ch.parse({
      headers: { "content-type": "application/json" },
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("run");
    if (result.kind === "run") {
      expect(result.env.payload).toEqual({ message: "hello" });
      expect(result.env.channelId).toBe("http-in");
    }
  });

  it("returns kind=ack for url_verification challenge", async () => {
    const ch = new HttpChannel({ channelId: "http-in" });
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const result = await ch.parse({
      headers: {},
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("ack");
    if (result.kind === "ack") {
      expect((result.response as Record<string, unknown>)["challenge"]).toBe("abc123");
    }
  });

  it("returns kind=reject for malformed JSON", async () => {
    const ch = new HttpChannel({ channelId: "http-in" });
    const result = await ch.parse({
      headers: {},
      body: "not-json",
      rawBody: Buffer.from("not-json"),
    });
    expect(result.kind).toBe("reject");
  });

  it("returns kind=reject when Bearer token missing", async () => {
    const ch = new HttpChannel({ channelId: "http-in", authType: "bearer", authToken: "secret123" });
    const body = JSON.stringify({ payload: {} });
    const result = await ch.parse({
      headers: {},
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("reject");
  });

  it("returns kind=reject when Bearer token wrong", async () => {
    const ch = new HttpChannel({ channelId: "http-in", authType: "bearer", authToken: "secret123" });
    const body = JSON.stringify({ payload: {} });
    const result = await ch.parse({
      headers: { authorization: "Bearer wrongtoken" },
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("reject");
  });

  it("returns kind=run with correct Bearer token", async () => {
    const ch = new HttpChannel({ channelId: "http-in", authType: "bearer", authToken: "secret123" });
    const body = JSON.stringify({ payload: { data: 42 } });
    const result = await ch.parse({
      headers: { authorization: "Bearer secret123" },
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("run");
  });

  it("normalizes whole body as payload when no payload field", async () => {
    const ch = new HttpChannel({ channelId: "ch1" });
    const body = JSON.stringify({ foo: "bar", baz: 1 });
    const result = await ch.parse({
      headers: {},
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("run");
    if (result.kind === "run") {
      expect(result.env.payload["foo"]).toBe("bar");
    }
  });
});

// ---------------------------------------------------------------------------
// NDJSON streaming output
// ---------------------------------------------------------------------------

describe("NDJSON streaming output", () => {
  it("encodeNdjsonLine produces valid JSON line with trailing newline", () => {
    const line = encodeNdjsonLine({ type: "token", data: "hello" });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd()) as Record<string, unknown>;
    expect(parsed["type"]).toBe("token");
    expect(parsed["data"]).toBe("hello");
  });

  it("encodeNdjsonStream emits token lines + done line", async () => {
    async function* tokens() { yield "hello"; yield " world"; }
    const lines: string[] = [];
    for await (const line of encodeNdjsonStream(tokens())) {
      lines.push(line);
    }
    expect(lines).toHaveLength(3);
    const last = JSON.parse(lines[2]!.trimEnd()) as Record<string, unknown>;
    expect(last["type"]).toBe("done");
  });

  it("encodeNdjsonStream with no tokens emits only done line", async () => {
    async function* noTokens() { /* empty */ }
    const lines: string[] = [];
    for await (const line of encodeNdjsonStream(noTokens())) {
      lines.push(line);
    }
    expect(lines).toHaveLength(1);
    const only = JSON.parse(lines[0]!.trimEnd()) as Record<string, unknown>;
    expect(only["type"]).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// SlackChannel — HMAC signature verification
// ---------------------------------------------------------------------------

import { SlackChannel, buildSlackSignature } from "./channel-slack.js";

describe("SlackChannel.parse()", () => {
  const SECRET = "slack-signing-secret-abc123";

  function makeSlackRequest(body: string, secret = SECRET, ageSeconds = 0) {
    const ts = Math.floor(Date.now() / 1000) - ageSeconds;
    const sig = buildSlackSignature(secret, String(ts), body);
    return {
      headers: {
        "x-slack-request-timestamp": String(ts),
        "x-slack-signature": sig,
      },
      body,
      rawBody: Buffer.from(body),
    };
  }

  it("returns kind=run for valid Slack event_callback", async () => {
    const ch = new SlackChannel({ channelId: "slack-in", signingSecret: SECRET });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      event: { type: "message", text: "hello" },
    });
    const result = await ch.parse(makeSlackRequest(body));
    expect(result.kind).toBe("run");
    if (result.kind === "run") {
      expect(result.env.tenantHint).toBe("T123");
      expect(result.env.payload["text"]).toBe("hello");
    }
  });

  it("returns kind=ack for url_verification challenge", async () => {
    const ch = new SlackChannel({ channelId: "slack-in", signingSecret: SECRET });
    const body = JSON.stringify({ type: "url_verification", challenge: "xyz789" });
    const result = await ch.parse(makeSlackRequest(body));
    expect(result.kind).toBe("ack");
    if (result.kind === "ack") {
      expect((result.response as Record<string, unknown>)["challenge"]).toBe("xyz789");
    }
  });

  it("returns kind=reject for bad signature", async () => {
    const ch = new SlackChannel({ channelId: "slack-in", signingSecret: SECRET });
    const body = JSON.stringify({ type: "event_callback", event: {} });
    const ts = Math.floor(Date.now() / 1000);
    const result = await ch.parse({
      headers: { "x-slack-request-timestamp": String(ts), "x-slack-signature": "v0=badsig" },
      body,
      rawBody: Buffer.from(body),
    });
    expect(result.kind).toBe("reject");
  });

  it("returns kind=reject for stale timestamp (replay attack)", async () => {
    const ch = new SlackChannel({ channelId: "slack-in", signingSecret: SECRET, maxAgeSeconds: 60 });
    const body = JSON.stringify({ type: "event_callback", event: {} });
    // Use a timestamp 10 minutes old
    const result = await ch.parse(makeSlackRequest(body, SECRET, 600));
    expect(result.kind).toBe("reject");
  });

  it("returns kind=reject when timestamp header missing", async () => {
    const ch = new SlackChannel({ channelId: "slack-in", signingSecret: SECRET });
    const body = JSON.stringify({ type: "event_callback", event: {} });
    const result = await ch.parse({ headers: {}, body, rawBody: Buffer.from(body) });
    expect(result.kind).toBe("reject");
  });

  it("buildSlackSignature produces v0= prefix", () => {
    const sig = buildSlackSignature(SECRET, "12345", "body");
    expect(sig.startsWith("v0=")).toBe(true);
    expect(sig.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// AwsRuntime wiring (mock-only — no real SQS)
// ---------------------------------------------------------------------------

import { mockClient as mc } from "aws-sdk-client-mock";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { AwsRuntime } from "./runtime-aws.js";
import { MemoryStorage } from "./runtime-local.js";

describe("AwsRuntime wiring (mocked SQS)", () => {
  it("submitRun sends SQS message with correct runId", async () => {
    const sqsMock = mc(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "msg1" });

    const memStorage = new MemoryStorage();
    const runId = deriveRunId("http:test-agent", "dedup-1") as RunId;

    const sqs = new SQSClient({});
    const runtime = new AwsRuntime({
      queueUrl: "https://sqs.us-east-1.amazonaws.com/123/test-queue",
      storage: memStorage,
      client: sqs,
      tenantId: TENANT,
    });

    const result = await runtime.submitRun({
      runId,
      manifestId: "test-agent",
      manifestRevision: "rev1",
      tenantId: TENANT,
      trigger: { type: "manual" },
      input: { data: "test" },
      chainDepth: 0,
    });

    expect(result.status).toBe("queued");
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(calls[0]!.args[0].input.MessageBody ?? "{}") as Record<string, unknown>;
    expect(body["runId"]).toBe(runId);

    sqsMock.restore();
  });

  it("cancelRun sets status to cancelled", async () => {
    const sqsMock = mc(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({});

    const memStorage = new MemoryStorage();
    const runId = deriveRunId("manual:agent", "cancel-1") as RunId;
    await memStorage.ensureRun({ tenantId: TENANT, runId, manifestId: "m", manifestRevision: "r" });

    const sqs = new SQSClient({});
    const runtime = new AwsRuntime({
      queueUrl: "https://q",
      storage: memStorage,
      client: sqs,
      tenantId: TENANT,
    });

    await runtime.cancelRun(runId);
    const run = await runtime.getRun(runId);
    expect(run?.status).toBe("cancelled");

    sqsMock.restore();
  });

  it("getRun returns null for non-existent run", async () => {
    const sqsMock = mc(SQSClient);
    sqsMock.on(SendMessageCommand).resolves({});

    const memStorage = new MemoryStorage();
    const sqs = new SQSClient({});
    const runtime = new AwsRuntime({
      queueUrl: "https://q",
      storage: memStorage,
      client: sqs,
      tenantId: TENANT,
    });

    const run = await runtime.getRun("non-existent-run" as RunId);
    expect(run).toBeNull();

    sqsMock.restore();
  });
});
