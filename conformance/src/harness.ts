// SPDX-License-Identifier: Apache-2.0
/**
 * harness.ts — the real-AWS conformance harness entry point.
 *
 * Usage:
 *   tsx src/harness.ts --stage <stage> --region <region> --dir <path> [--dry-run]
 *
 * Sequence: deploy → CHECKS (t3, t6-hold, t5-redeploy, t6-resume-iam,
 * tool-output) → teardown, with teardown running in a `finally` block so a
 * throwaway stage is ALWAYS torn down even when a check fails or throws.
 *
 * --dry-run: no AWS, no network, no child_process `sst`/`aws` calls.
 *   - "deploy" reads the committed fixtures/deploy-stdout.txt through the
 *     SAME parseSstOutputs() parser used in real mode.
 *   - Storage is an in-memory MemoryStorage (from @draht/runtime-aws) wired to
 *     a tiny in-process fake of the ingress/resume Lambda handlers that walks
 *     a run through queued → awaiting_approval → completed.
 *   - teardown prints the planTeardown() action list only — no AWS calls.
 *
 * Exit code: non-zero if any NON-SKIPPED check fails.
 */

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { MemoryStorage, DynamoStorage } from "@draht/runtime-aws";
import type { TenantId } from "@draht/core/seams";

import { parseSstOutputs } from "./sst-outputs.js";
import { planTeardown, teardownStage, tableNamePrefix, type TeardownAction } from "./teardown.js";
import {
  CHECKS,
  createUnsignedPostJson,
  createSignedPostJson,
  type CheckContext,
  type CheckResult,
  type HttpResult,
} from "./checks.js";
import { makeFakeBackend } from "./fake-backend.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The reference-playbook's stack output naming (sst.config.ts, Task 2).
const AGENT_NAME = "SupportTriageAgent";
const DEFAULT_TENANT_ID = "default" as TenantId;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface HarnessArgs {
  stage: string;
  region: string;
  dir: string;
  dryRun: boolean;
}

function parseHarnessArgs(argv: string[]): HarnessArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      stage: { type: "string" },
      region: { type: "string" },
      dir: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });

  const dryRun = Boolean(values["dry-run"]);
  return {
    stage: (values["stage"] as string | undefined) ?? (dryRun ? "dry-run" : ""),
    region: (values["region"] as string | undefined) ?? "eu-central-1",
    dir: resolve((values["dir"] as string | undefined) ?? "examples/reference-playbook"),
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Real mode wiring
// ---------------------------------------------------------------------------

async function deployReal(stage: string, region: string, dir: string): Promise<Record<string, string>> {
  const { deploy } = await import("@draht/platine");
  const result = await deploy({ dir, stage, region });
  if (result.exitCode !== 0) {
    throw new Error(`sst deploy failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
  const outputs = parseSstOutputs(result.stdout);
  assertRequiredOutputs(outputs);
  return outputs;
}

/**
 * Validate that every stack output key the harness depends on downstream
 * (httpUrl / resumeUrl / tableName — feeding both the HTTP checks and
 * DynamoStorage) is present and non-empty. Silently degrading a missing key
 * to "" would feed `new DynamoStorage("")` / `fetch("")` and fail far from
 * the actual cause, so fail fast here naming exactly which key(s) are missing.
 */
function assertRequiredOutputs(outputs: Record<string, string>): void {
  const requiredKeys = [`${AGENT_NAME}Url`, `${AGENT_NAME}ResumeUrl`, `${AGENT_NAME}TableName`];
  const missing = requiredKeys.filter((key) => !outputs[key] || outputs[key]!.length === 0);
  if (missing.length > 0) {
    throw new Error(
      `sst deploy succeeded but stack outputs are missing required key(s): ${missing.join(", ")} ` +
        `(got keys: ${Object.keys(outputs).join(", ") || "<none>"})`,
    );
  }
}

async function redeployReal(stage: string, region: string, dir: string): Promise<void> {
  const { deploy } = await import("@draht/platine");
  const result = await deploy({ dir, stage, region });
  if (result.exitCode !== 0) {
    throw new Error(`sst deploy (redeploy) failed (exit ${result.exitCode}):\n${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Dry-run mode wiring — zero network, zero AWS, zero child_process
// ---------------------------------------------------------------------------

async function deployDryRun(): Promise<Record<string, string>> {
  const fixturePath = resolve(__dirname, "../fixtures/deploy-stdout.txt");
  const stdout = await readFile(fixturePath, "utf8");
  return parseSstOutputs(stdout);
}

const DRY_RUN_HTTP_URL = "dry-run://ingress";
const DRY_RUN_RESUME_URL = "dry-run://resume";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printCheckTable(results: Array<{ id: string; result: CheckResult }>): void {
  const idWidth = Math.max(...results.map((r) => r.id.length), "CHECK".length);
  const statusWidth = Math.max(...results.map((r) => r.result.status.length), "STATUS".length);

  const header = `${"CHECK".padEnd(idWidth)}  ${"STATUS".padEnd(statusWidth)}  DETAIL`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const { id, result } of results) {
    console.log(`${id.padEnd(idWidth)}  ${result.status.padEnd(statusWidth)}  ${result.detail}`);
  }
}

function printTeardownPlan(actions: TeardownAction[]): void {
  console.log("\nTeardown plan:");
  for (const action of actions) {
    if (action.kind === "sst-remove") {
      console.log(`  - sst-remove (stage=${action.stage})`);
    } else {
      console.log(`  - ${action.kind} (table=${action.tableName})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseHarnessArgs(process.argv.slice(2));

  if (!args.dryRun && args.stage.length === 0) {
    console.error("[harness] --stage is required (unless --dry-run is set)");
    process.exitCode = 2;
    return;
  }

  console.log(
    `[harness] ${args.dryRun ? "DRY-RUN" : "REAL-AWS"} stage=${args.stage} region=${args.region} dir=${args.dir}`,
  );

  let exitCode = 0;
  const results: Array<{ id: string; result: CheckResult }> = [];

  try {
    // ---- deploy ----
    const outputs = args.dryRun
      ? await deployDryRun()
      : await deployReal(args.stage, args.region, args.dir);

    const httpUrl = args.dryRun ? DRY_RUN_HTTP_URL : (outputs[`${AGENT_NAME}Url`] ?? "");
    const resumeUrl = args.dryRun ? DRY_RUN_RESUME_URL : (outputs[`${AGENT_NAME}ResumeUrl`] ?? "");
    const tableName = outputs[`${AGENT_NAME}TableName`] ?? "";

    console.log(`[harness] deploy complete. httpUrl=${httpUrl} tableName=${tableName}`);

    // ---- wire storage + http client ----
    let storage: MemoryStorage | DynamoStorage;
    let postJson: (url: string, body: unknown) => Promise<HttpResult>;
    let postJsonSigned: (url: string, body: unknown) => Promise<HttpResult>;

    if (args.dryRun) {
      const memStorage = new MemoryStorage();
      storage = memStorage;
      ({ postJson, postJsonSigned } = makeFakeBackend(
        memStorage,
        DEFAULT_TENANT_ID,
        { httpUrl: DRY_RUN_HTTP_URL, resumeUrl: DRY_RUN_RESUME_URL },
        "rev_dry_run",
      ));
    } else {
      const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
      storage = new DynamoStorage(tableName, docClient);
      postJson = createUnsignedPostJson();
      postJsonSigned = createSignedPostJson(args.region);
    }

    const ctx: CheckContext = {
      httpUrl,
      resumeUrl,
      region: args.region,
      storage,
      tenantId: DEFAULT_TENANT_ID,
      state: {},
      postJson,
      postJsonSigned,
      redeploy: args.dryRun
        ? async () => {}
        : async () => redeployReal(args.stage, args.region, args.dir),
      pollIntervalMs: args.dryRun ? 1 : 2000,
      pollTimeoutMs: args.dryRun ? 5000 : 180_000,
    };

    // ---- run checks in order ----
    for (const check of CHECKS) {
      let result: CheckResult;
      try {
        result = await check.run(ctx);
      } catch (err) {
        result = { status: "fail", detail: err instanceof Error ? err.message : String(err) };
      }
      results.push({ id: check.id, result });
      if (result.status === "fail") exitCode = 1;
    }

    console.log("");
    printCheckTable(results);
  } catch (err) {
    console.error(`[harness] fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    // ---- teardown — ALWAYS runs, even on fatal error / check failure ----
    if (args.dryRun) {
      const allTableNames = [`${tableNamePrefix(args.stage)}supporttriageagenttabletable`];
      printTeardownPlan(planTeardown({ stage: args.stage, allTableNames }));
    } else {
      console.log(`\n[harness] tearing down stage=${args.stage}...`);
      try {
        const report = await teardownStage({ stage: args.stage, region: args.region, dir: args.dir });
        console.log(
          `[harness] teardown complete. sstRemoveExitCode=${report.sstRemoveExitCode} tablesDeleted=${JSON.stringify(report.tablesDeleted)}`,
        );
      } catch (err) {
        console.error(
          `[harness] TEARDOWN FAILED — manual cleanup required for stage=${args.stage}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        exitCode = 1;
      }
    }
  }

  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  console.error(`[harness] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
