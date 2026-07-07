// SPDX-License-Identifier: Apache-2.0
/**
 * teardown.test.ts — planTeardown() unit tests (PURE — no AWS, no
 * child_process), plus teardownStage() tests that inject a fake `sst`
 * command (`true`/`false`, always present on POSIX CI runners) and a fake
 * DynamoDBClient so the "never swallow a failed sst remove" and "attempt
 * every table" invariants are unit-tested without touching real infra.
 */

import { describe, it, expect } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import {
  ListTablesCommand,
  UpdateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  planTeardown,
  tableNamePrefix,
  teardownStage,
  assertSstRemoveSucceeded,
  type TeardownAction,
} from "./teardown.js";

describe("planTeardown", () => {
  it("always starts with sst-remove for the given stage", () => {
    const actions = planTeardown({ stage: "ci-1", allTableNames: [] });
    expect(actions[0]).toEqual({ kind: "sst-remove", stage: "ci-1" });
  });

  it("emits disable-protection then delete-table then verify-deleted, in that order, per matching table", () => {
    const stage = "ci-42";
    const table = `${tableNamePrefix(stage)}supporttriageagenttabletable`;
    const actions = planTeardown({ stage, allTableNames: [table] });

    const kinds = actions.map((a) => a.kind);
    expect(kinds).toEqual(["sst-remove", "disable-protection", "delete-table", "verify-deleted"]);

    const disableIdx = actions.findIndex(
      (a) => a.kind === "disable-protection" && a.tableName === table,
    );
    const deleteIdx = actions.findIndex((a) => a.kind === "delete-table" && a.tableName === table);
    const verifyIdx = actions.findIndex(
      (a) => a.kind === "verify-deleted" && a.tableName === table,
    );

    expect(disableIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(disableIdx);
    expect(verifyIdx).toBeGreaterThan(deleteIdx);
  });

  it("NEVER emits a delete-table action without a preceding disable-protection for the same table", () => {
    const stage = "ci-99";
    const tables = [
      `${tableNamePrefix(stage)}a`,
      `${tableNamePrefix(stage)}b`,
      `${tableNamePrefix(stage)}c`,
    ];
    const actions = planTeardown({ stage, allTableNames: tables });

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i] as TeardownAction;
      if (action.kind !== "delete-table") continue;
      const precedingDisable = actions
        .slice(0, i)
        .some((a) => a.kind === "disable-protection" && a.tableName === action.tableName);
      expect(precedingDisable).toBe(true);
    }
  });

  it("filters out tables that do not match this stage's prefix", () => {
    const stage = "ci-1";
    const otherStageTable = `${tableNamePrefix("ci-2")}sometable`;
    const unrelatedTable = "some-other-app-table";
    const ownTable = `${tableNamePrefix(stage)}owntable`;

    const actions = planTeardown({
      stage,
      allTableNames: [otherStageTable, unrelatedTable, ownTable],
    });

    const touchedTables = actions
      .filter((a): a is Extract<TeardownAction, { tableName: string }> => "tableName" in a)
      .map((a) => a.tableName);

    expect(touchedTables).toEqual([ownTable, ownTable, ownTable]);
  });

  it("does NOT let a numeric-prefix stage (ci-1) cross into a longer stage's tables (ci-12) — the trailing hyphen is load-bearing", () => {
    const stage = "ci-1";
    // Without the trailing hyphen in tableNamePrefix(), "draht-reference-playbook-ci-1"
    // would be a prefix of "draht-reference-playbook-ci-12-...", incorrectly matching
    // stage ci-12's table when tearing down stage ci-1.
    const ci1Table = `${tableNamePrefix("ci-1")}owntable`;
    const ci12Table = `${tableNamePrefix("ci-12")}owntable`;

    const actions = planTeardown({ stage, allTableNames: [ci1Table, ci12Table] });

    const touchedTables = actions
      .filter((a): a is Extract<TeardownAction, { tableName: string }> => "tableName" in a)
      .map((a) => a.tableName);

    expect(touchedTables).toEqual([ci1Table, ci1Table, ci1Table]);
    expect(touchedTables).not.toContain(ci12Table);
  });

  it("emits no per-table actions when no tables match the prefix", () => {
    const actions = planTeardown({ stage: "ci-lonely", allTableNames: ["unrelated-table"] });
    expect(actions).toEqual([{ kind: "sst-remove", stage: "ci-lonely" }]);
  });

  it("is deterministic for the same input", () => {
    const stage = "ci-7";
    const tables = [`${tableNamePrefix(stage)}x`, `${tableNamePrefix(stage)}y`];
    const first = planTeardown({ stage, allTableNames: tables });
    const second = planTeardown({ stage, allTableNames: tables });
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// assertSstRemoveSucceeded — pure check of a spawnSync() result
// ---------------------------------------------------------------------------

/** Builds a full SpawnSyncReturns<string> stub — only status/error/stdout/stderr vary per test. */
function fakeSpawnResult(overrides: {
  status: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}): SpawnSyncReturns<string> {
  const base = {
    pid: 12345,
    output: [null, overrides.stdout ?? "", overrides.stderr ?? ""],
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    status: overrides.status,
    signal: null,
  };
  return overrides.error ? { ...base, error: overrides.error } : (base as SpawnSyncReturns<string>);
}

describe("assertSstRemoveSucceeded", () => {
  it("returns the exit code when status is 0", () => {
    const result = fakeSpawnResult({ status: 0, stdout: "removed\n" });
    expect(assertSstRemoveSucceeded("ci-1", result)).toBe(0);
  });

  it("throws, naming the exit code and echoing stdout/stderr, when status is nonzero", () => {
    const result = fakeSpawnResult({
      status: 1,
      stdout: "some progress output",
      stderr: "Error: stack ci-1 failed to remove",
    });
    expect(() => assertSstRemoveSucceeded("ci-1", result)).toThrow(
      /sst remove --stage ci-1 failed \(exit code 1\)/,
    );
    try {
      assertSstRemoveSucceeded("ci-1", result);
    } catch (err) {
      expect((err as Error).message).toContain("some progress output");
      expect((err as Error).message).toContain("Error: stack ci-1 failed to remove");
    }
  });

  it("throws, naming the spawn error, when the child process could not even be spawned (e.g. ENOENT)", () => {
    const spawnError = Object.assign(new Error("spawn sst ENOENT"), { code: "ENOENT" });
    const result = fakeSpawnResult({ status: null, error: spawnError });
    expect(() => assertSstRemoveSucceeded("ci-1", result)).toThrow(/spawn error: spawn sst ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// teardownStage — end-to-end with an injected fake `sst` command + fake client
// ---------------------------------------------------------------------------

/** Minimal fake DynamoDBClient — only the 4 commands teardownStage sends. */
class FakeDynamoDBClient {
  public readonly sent: string[] = [];
  constructor(
    private readonly opts: {
      tables: string[];
      failCommandForTable?: { kind: "update" | "delete"; tableName: string };
    },
  ) {}

  async send(command: unknown): Promise<{ TableNames?: string[] }> {
    if (command instanceof ListTablesCommand) {
      return { TableNames: this.opts.tables };
    }
    if (command instanceof UpdateTableCommand) {
      const tableName = command.input.TableName as string;
      this.sent.push(`update:${tableName}`);
      if (this.opts.failCommandForTable?.kind === "update" && this.opts.failCommandForTable.tableName === tableName) {
        throw new Error(`simulated UpdateTable failure for ${tableName}`);
      }
      return {};
    }
    if (command instanceof DeleteTableCommand) {
      const tableName = command.input.TableName as string;
      this.sent.push(`delete:${tableName}`);
      if (this.opts.failCommandForTable?.kind === "delete" && this.opts.failCommandForTable.tableName === tableName) {
        throw new Error(`simulated DeleteTable failure for ${tableName}`);
      }
      return {};
    }
    if (command instanceof DescribeTableCommand) {
      const tableName = command.input.TableName as string;
      this.sent.push(`describe:${tableName}`);
      // Table is gone immediately — matches how MemoryDynamoDBClient tests
      // elsewhere in this repo simulate an already-deleted table.
      throw new ResourceNotFoundException({ message: "not found", $metadata: {} });
    }
    throw new Error(`FakeDynamoDBClient: unhandled command ${(command as { constructor: { name: string } }).constructor.name}`);
  }
}

describe("teardownStage", () => {
  it("throws (does not silently swallow) when sst remove exits nonzero", async () => {
    const client = new FakeDynamoDBClient({ tables: [] });
    await expect(
      teardownStage({
        stage: "ci-fail",
        region: "eu-central-1",
        dir: ".",
        _sstCommand: "false", // POSIX command always present, always exits 1
        _client: client as unknown as DynamoDBClient,
      }),
    ).rejects.toThrow(/sst remove --stage ci-fail failed/);
  });

  it("deletes every matching table after a successful sst remove", async () => {
    const stage = "ci-ok";
    const table = `${tableNamePrefix(stage)}owntable`;
    const client = new FakeDynamoDBClient({ tables: [table] });

    const report = await teardownStage({
      stage,
      region: "eu-central-1",
      dir: ".",
      _sstCommand: "true", // POSIX command always present, always exits 0
      _client: client as unknown as DynamoDBClient,
    });

    expect(report.sstRemoveExitCode).toBe(0);
    expect(report.tablesDeleted).toEqual([table]);
    expect(client.sent).toEqual([`update:${table}`, `delete:${table}`, `describe:${table}`]);
  });

  it("is idempotent: sst remove succeeding with zero matching tables never touches DynamoDB tables", async () => {
    const client = new FakeDynamoDBClient({ tables: ["unrelated-table"] });
    const report = await teardownStage({
      stage: "ci-already-removed",
      region: "eu-central-1",
      dir: ".",
      _sstCommand: "true",
      _client: client as unknown as DynamoDBClient,
    });
    expect(report.tablesDeleted).toEqual([]);
    expect(client.sent).toEqual([]);
  });

  it("attempts every table even when one table's disable-protection fails, and aggregates the error", async () => {
    const stage = "ci-partial";
    const badTable = `${tableNamePrefix(stage)}bad`;
    const goodTable = `${tableNamePrefix(stage)}good`;
    const client = new FakeDynamoDBClient({
      tables: [badTable, goodTable],
      failCommandForTable: { kind: "update", tableName: badTable },
    });

    await expect(
      teardownStage({
        stage,
        region: "eu-central-1",
        dir: ".",
        _sstCommand: "true",
        _client: client as unknown as DynamoDBClient,
      }),
    ).rejects.toThrow(/1 table teardown action\(s\) failed/);

    // The good table was still fully attempted (update → delete → describe)
    // even though the bad table failed at update.
    expect(client.sent).toContain(`update:${badTable}`);
    expect(client.sent).not.toContain(`delete:${badTable}`); // stopped after the failing step
    expect(client.sent).toEqual(
      expect.arrayContaining([`update:${goodTable}`, `delete:${goodTable}`, `describe:${goodTable}`]),
    );
  });
});
