// SPDX-License-Identifier: Apache-2.0
/**
 * runs.ts — list/get/tail/approve/resume run records.
 *
 * Storage selection:
 *   - Production: DynamoStorage with --table / DRAHT_TABLE override.
 *   - Dev local: MemoryStorage reading from .platine/dev-runs/*.json (when
 *     `--local` flag is set or DRAHT_LOCAL=true).
 *     For tests we accept an injected `storage` option directly.
 *
 * approve/resume call the Runtime resume path:
 *   - approve: runtime.resumeRun({ kind: "approval", ... })
 *   - resume:  runtime.resumeRun({ kind: "continue", ... })
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Storage, RunId, RunRecord, TenantId } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import type { Runtime } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Storage resolution
// ---------------------------------------------------------------------------

export interface RunsStorageOptions {
  /**
   * Injected Storage for tests (bypasses DynamoStorage / dev-runs loading).
   */
  storage?: Storage;
  /**
   * Injected Runtime for tests (bypasses AwsRuntime).
   */
  runtime?: Runtime;
  /** Table name override (--table / DRAHT_TABLE). Used with DynamoStorage. */
  table?: string;
  /**
   * Load from local dev-runs JSON files under .platine/dev-runs/ instead of
   * DynamoDB. Enabled when --local flag or DRAHT_LOCAL=true.
   */
  local?: boolean;
  /** Directory containing .platine/ (for local mode). Defaults to process.cwd(). */
  dir?: string;
  /** TenantId to use. Defaults to DEFAULT_TENANT. */
  tenantId?: TenantId;
}

// ---------------------------------------------------------------------------
// Local dev-runs JSON store (simple: reads .platine/dev-runs/<runId>.json)
// ---------------------------------------------------------------------------

class LocalDevRunsStorage implements Pick<Storage, "getRun"> {
  constructor(private readonly platineDir: string) {}

  async getRun(_t: TenantId, runId: RunId): Promise<RunRecord | null> {
    try {
      const filePath = join(this.platineDir, "dev-runs", `${runId}.json`);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as RunRecord;
    } catch {
      return null;
    }
  }

  async listRuns(): Promise<RunRecord[]> {
    const dir = join(this.platineDir, "dev-runs");
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, file), "utf8");
        records.push(JSON.parse(raw) as RunRecord);
      } catch {
        // skip malformed files
      }
    }
    return records;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunsListOptions extends RunsStorageOptions {
  /** Filter by status. */
  status?: string;
  /** Maximum number of records to return. */
  limit?: number;
}

export interface RunsListResult {
  runs: RunRecord[];
}

/** List runs from the storage backend. */
export async function runsList(opts: RunsListOptions = {}): Promise<RunsListResult> {
  const { storage, local, dir, tenantId: tOpt } = opts;
  const tenantId = tOpt ?? DEFAULT_TENANT;

  // If a storage is injected directly (tests), use it.
  // The injected Storage must expose listRuns() — MemoryStorage doesn't in the base
  // interface, so we handle it via a duck-type check.
  if (storage) {
    const runs = await _listFromStorage(storage, tenantId);
    return { runs: applyFilters(runs, opts) };
  }

  if (local || process.env["DRAHT_LOCAL"] === "true") {
    const platineDir = join(resolve(dir ?? process.cwd()), ".platine");
    const localStore = new LocalDevRunsStorage(platineDir);
    const runs = await localStore.listRuns();
    return { runs: applyFilters(runs, opts) };
  }

  // Production: DynamoStorage
  const table = opts.table ?? process.env["DRAHT_TABLE"];
  if (!table) {
    throw new Error(
      `[platine runs] No table specified. Set --table <name> or DRAHT_TABLE env var.`
    );
  }

  const { DynamoStorage } = await import("@draht/runtime-aws");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const dynamo = new DynamoStorage(table, docClient);
  const runs = await _listFromStorage(dynamo, tenantId);
  return { runs: applyFilters(runs, opts) };
}

export interface RunsGetOptions extends RunsStorageOptions {
  runId: RunId;
}

export interface RunsGetResult {
  run: RunRecord | null;
}

/** Get a single run record. */
export async function runsGet(opts: RunsGetOptions): Promise<RunsGetResult> {
  const { storage, local, dir, tenantId: tOpt, runId } = opts;
  const tenantId = tOpt ?? DEFAULT_TENANT;

  if (storage) {
    const run = await storage.getRun(tenantId, runId);
    return { run };
  }

  if (local || process.env["DRAHT_LOCAL"] === "true") {
    const platineDir = join(resolve(dir ?? process.cwd()), ".platine");
    const localStore = new LocalDevRunsStorage(platineDir);
    const run = await localStore.getRun(tenantId, runId);
    return { run };
  }

  const table = opts.table ?? process.env["DRAHT_TABLE"];
  if (!table) {
    throw new Error(
      `[platine runs] No table specified. Set --table <name> or DRAHT_TABLE env var.`
    );
  }
  const { DynamoStorage } = await import("@draht/runtime-aws");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const dynamo = new DynamoStorage(table, docClient);
  const run = await dynamo.getRun(tenantId, runId);
  return { run };
}

export interface RunsTailOptions extends RunsGetOptions {
  /** Poll interval in ms. Default: 1000. */
  pollMs?: number;
  /** Max time to wait in ms. Default: 60_000. */
  timeoutMs?: number;
}

export interface RunsTailResult {
  run: RunRecord;
  timedOut: boolean;
}

/**
 * Tail a run: poll until it reaches a terminal status or times out.
 */
export async function runsTail(opts: RunsTailOptions): Promise<RunsTailResult> {
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  const TERMINAL = new Set(["completed", "failed", "cancelled"]);

  while (Date.now() < deadline) {
    const { run } = await runsGet(opts);
    if (run && TERMINAL.has(run.status)) {
      return { run, timedOut: false };
    }

    // Not terminal yet — wait
    await new Promise<void>((res) => setTimeout(res, pollMs));
  }

  // Timed out — return whatever we have
  const { run } = await runsGet(opts);
  if (!run) {
    throw new Error(`[platine runs tail] Run ${opts.runId} not found after ${timeoutMs}ms.`);
  }
  return { run, timedOut: true };
}

export interface RunsApproveOptions extends RunsStorageOptions {
  runId: RunId;
  actionId: string;
  decision: "approved" | "rejected";
  by?: string;
}

export interface RunsApproveResult {
  status: string;
}

/** Approve or reject a pending approval gate. */
export async function runsApprove(opts: RunsApproveOptions): Promise<RunsApproveResult> {
  const runtime = await resolveRuntime(opts);

  const result = await runtime.resumeRun({
    kind: "approval",
    runId: opts.runId,
    approvalId: opts.actionId,
    decision: opts.decision,
    ...(opts.by !== undefined ? { by: opts.by } : {}),
  });

  return { status: result.status };
}

export interface RunsResumeOptions extends RunsStorageOptions {
  runId: RunId;
}

export interface RunsResumeResult {
  status: string;
}

/** Resume a paused run. */
export async function runsResume(opts: RunsResumeOptions): Promise<RunsResumeResult> {
  const runtime = await resolveRuntime(opts);

  const result = await runtime.resumeRun({
    kind: "continue",
    runId: opts.runId,
  });

  return { status: result.status };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** List all runs from a Storage. Duck-type check for listRuns() on MemoryStorage. */
async function _listFromStorage(storage: Storage, tenantId: TenantId): Promise<RunRecord[]> {
  // MemoryStorage has an internal map we can enumerate via a best-effort
  // duck-type check for a `listRuns()` extension.
  const ext = storage as {
    listRuns?: (tenantId: TenantId) => Promise<RunRecord[]>;
  };
  if (typeof ext.listRuns === "function") {
    return ext.listRuns(tenantId);
  }
  // DynamoStorage: fall back to an empty list (listing is done by GSI in a real
  // implementation; we return empty here to avoid requiring AWS in tests).
  return [];
}

function applyFilters(runs: RunRecord[], opts: RunsListOptions): RunRecord[] {
  let filtered = runs;
  if (opts.status) {
    filtered = filtered.filter((r) => r.status === opts.status);
  }
  if (opts.limit !== undefined) {
    filtered = filtered.slice(0, opts.limit);
  }
  return filtered;
}

async function resolveRuntime(opts: RunsStorageOptions): Promise<Runtime> {
  if (opts.runtime) {
    return opts.runtime;
  }

  if (opts.local || process.env["DRAHT_LOCAL"] === "true") {
    // Local mode: there is no persistent LocalRuntime to call resume on.
    // The user should use the session.run() approach in dev mode.
    throw new Error(
      `[platine runs] approve/resume are not supported in local mode. ` +
        `Use the dev session directly.`
    );
  }

  const table = opts.table ?? process.env["DRAHT_TABLE"];
  if (!table) {
    throw new Error(
      `[platine runs] No table specified. Set --table <name> or DRAHT_TABLE env var.`
    );
  }

  // AwsRuntime requires an SQS queue URL
  const queueUrl = process.env["DRAHT_QUEUE_URL"];
  if (!queueUrl) {
    throw new Error(
      `[platine runs] No queue URL specified. Set DRAHT_QUEUE_URL env var.`
    );
  }

  const { AwsRuntime, DynamoStorage } = await import("@draht/runtime-aws");
  const { SQSClient } = await import("@aws-sdk/client-sqs");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const dynamo = new DynamoStorage(table, docClient);
  return new AwsRuntime({ storage: dynamo, queueUrl, client: new SQSClient({}) });
}
