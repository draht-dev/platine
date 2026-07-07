// SPDX-License-Identifier: Apache-2.0
/**
 * teardown.ts — guaranteed teardown for a throwaway conformance stage.
 *
 * The reference-playbook's DynamoDB table is provisioned with
 * `removal:'retain'` + `deletionProtection:true` (R3 must-fix — required so an
 * in-flight run survives `sst deploy`/`sst remove`). That means `sst remove`
 * alone does NOT delete the table: it survives on purpose. The conformance
 * harness therefore does a two-phase teardown:
 *
 *   1. `sst remove --stage <stage>` — tears down every OTHER resource
 *      (Lambda, SQS, EventBridge, alarms, IAM).
 *   2. ListTables → filter client-side on the `draht-reference-playbook-<stage>-`
 *      prefix → per matching table: UpdateTable(DeletionProtectionEnabled:false)
 *      then DeleteTable → verify via DescribeTable → ResourceNotFoundException.
 *
 * planTeardown() is the PURE ordering logic (no AWS, no child_process) so the
 * "never delete without disabling protection first" invariant is unit-tested
 * without touching real infrastructure.
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  DynamoDBClient,
  ListTablesCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";

// ---------------------------------------------------------------------------
// Table naming
// ---------------------------------------------------------------------------

/**
 * The reference-playbook's managed DynamoDB table is always named
 * `draht-reference-playbook-<stage>-...` by SST's resource-naming convention.
 * Filtering client-side on this prefix (rather than trusting a single known
 * name) protects other stages / tables in the same account from an accidental
 * DeleteTable call.
 */
export function tableNamePrefix(stage: string): string {
  return `draht-reference-playbook-${stage}-`;
}

// ---------------------------------------------------------------------------
// planTeardown — PURE ordering logic
// ---------------------------------------------------------------------------

export type TeardownAction =
  | { kind: "sst-remove"; stage: string }
  | { kind: "disable-protection"; tableName: string }
  | { kind: "delete-table"; tableName: string }
  | { kind: "verify-deleted"; tableName: string };

/**
 * Given the stage being torn down and the FULL list of table names visible to
 * the account (as returned by ListTables), produce the ordered teardown plan:
 *
 *   1. sst remove (always first — tears down everything else)
 *   2. for each table matching this stage's prefix, in a fixed per-table order:
 *      disable-protection → delete-table → verify-deleted
 *
 * Tables NOT matching the prefix are never touched.
 */
export function planTeardown(params: {
  stage: string;
  allTableNames: string[];
}): TeardownAction[] {
  const prefix = tableNamePrefix(params.stage);
  const matching = params.allTableNames.filter((n) => n.startsWith(prefix));

  const actions: TeardownAction[] = [{ kind: "sst-remove", stage: params.stage }];
  for (const tableName of matching) {
    actions.push({ kind: "disable-protection", tableName });
    actions.push({ kind: "delete-table", tableName });
    actions.push({ kind: "verify-deleted", tableName });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// teardownStage — executes the plan against real AWS + a real `sst` CLI
// ---------------------------------------------------------------------------

export interface TeardownStageOptions {
  /** SST stage to remove (e.g. "ci-1234567890"). */
  stage: string;
  /** AWS region the stage was deployed to. */
  region: string;
  /** Directory containing sst.config.ts (cwd for `sst remove`). */
  dir: string;
  /** Override the sst binary invoked (tests only). Defaults to "sst". */
  _sstCommand?: string;
  /** Injectable DynamoDBClient (tests only). Defaults to a real client for `region`. */
  _client?: DynamoDBClient;
}

export interface TeardownReport {
  stage: string;
  sstRemoveExitCode: number;
  tablesDeleted: string[];
}

/**
 * PURE check of a `spawnSync("sst", ["remove", ...])` result: throws a
 * descriptive error (naming the exit code / spawn error, and echoing
 * whatever stdout/stderr the child produced) unless the process actually
 * exited 0. Extracted so this "never silently swallow a failed sst remove"
 * invariant is unit-testable without spawning a real process.
 */
export function assertSstRemoveSucceeded(stage: string, result: SpawnSyncReturns<string>): number {
  if (result.error || result.status !== 0) {
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (stdout.length > 0) console.log(`[teardown] sst remove stdout:\n${stdout}`);
    if (stderr.length > 0) console.error(`[teardown] sst remove stderr:\n${stderr}`);
    const reason = result.error
      ? `spawn error: ${result.error.message}`
      : `exit code ${result.status ?? "null"}`;
    throw new Error(
      `[teardown] sst remove --stage ${stage} failed (${reason}). ` +
        `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  return result.status;
}

/**
 * Tear down a throwaway conformance stage end to end. Idempotent: safe to call
 * even if `sst remove` already ran or tables are already gone (missing tables
 * are simply absent from ListTables and therefore never targeted).
 */
export async function teardownStage(opts: TeardownStageOptions): Promise<TeardownReport> {
  const sstCmd = opts._sstCommand ?? "sst";
  const result = spawnSync(sstCmd, ["remove", "--stage", opts.stage], {
    cwd: opts.dir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  const sstRemoveExitCode = assertSstRemoveSucceeded(opts.stage, result);

  const client = opts._client ?? new DynamoDBClient({ region: opts.region });
  const allTableNames = await listAllTableNames(client);
  const actions = planTeardown({ stage: opts.stage, allTableNames });

  // Group the per-table actions (disable-protection → delete-table →
  // verify-deleted) in the order planTeardown emitted them, preserving
  // first-seen table order.
  const tableNamesInOrder: string[] = [];
  const actionsByTable = new Map<string, TeardownAction[]>();
  for (const action of actions) {
    if (action.kind === "sst-remove") continue; // already executed above
    let bucket = actionsByTable.get(action.tableName);
    if (!bucket) {
      bucket = [];
      actionsByTable.set(action.tableName, bucket);
      tableNamesInOrder.push(action.tableName);
    }
    bucket.push(action);
  }

  const tablesDeleted: string[] = [];
  const tableErrors: string[] = [];

  // Attempt every table independently: a failure disabling/deleting/verifying
  // one table must not prevent the others from being attempted. Within a
  // single table's sequence, stop at the first failing step (there is no
  // point deleting a table whose deletion-protection was never disabled).
  for (const tableName of tableNamesInOrder) {
    const tableActions = actionsByTable.get(tableName) ?? [];
    try {
      for (const action of tableActions) {
        if (action.kind === "disable-protection") {
          await client.send(
            new UpdateTableCommand({
              TableName: action.tableName,
              DeletionProtectionEnabled: false,
            }),
          );
        } else if (action.kind === "delete-table") {
          await client.send(new DeleteTableCommand({ TableName: action.tableName }));
          tablesDeleted.push(action.tableName);
        } else if (action.kind === "verify-deleted") {
          await verifyTableDeleted(client, action.tableName);
        }
      }
    } catch (err) {
      tableErrors.push(`[table=${tableName}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (tableErrors.length > 0) {
    throw new Error(
      `[teardown] ${tableErrors.length} table teardown action(s) failed for stage=${opts.stage}:\n` +
        tableErrors.join("\n"),
    );
  }

  return { stage: opts.stage, sstRemoveExitCode, tablesDeleted };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listAllTableNames(client: DynamoDBClient): Promise<string[]> {
  const names: string[] = [];
  let exclusiveStartTableName: string | undefined;
  do {
    const page = await client.send(
      new ListTablesCommand({ ExclusiveStartTableName: exclusiveStartTableName }),
    );
    names.push(...(page.TableNames ?? []));
    exclusiveStartTableName = page.LastEvaluatedTableName;
  } while (exclusiveStartTableName !== undefined);
  return names;
}

/** Poll DescribeTable until it throws ResourceNotFoundException, or give up. */
async function verifyTableDeleted(
  client: DynamoDBClient,
  tableName: string,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 30;
  const intervalMs = opts.intervalMs ?? 2000;

  for (let i = 0; i < attempts; i++) {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      throw err;
    }
    await new Promise<void>((res) => setTimeout(res, intervalMs));
  }
  throw new Error(
    `[teardown] table ${tableName} was not confirmed deleted after ${attempts} attempts`,
  );
}
