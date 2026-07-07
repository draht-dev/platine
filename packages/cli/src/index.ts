// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/platine CLI — bin entry point.
 *
 * Uses node:util parseArgs — no heavy CLI framework.
 * Commands:
 *   platine init [name] [-t workflow]  — scaffold a minimal agent directory
 *   platine dev [--dir <path>]         — run executor in-process (no sst dev)
 *   platine build [--dir <path>]       — tsc --check then compile → .platine/manifest.json
 *   platine deploy [--stage] [--region] — build → sst deploy
 *   platine runs list|get|tail|approve|resume
 *
 * `platine dev` does NOT spawn a second `sst dev` multiplexer.
 * Default model: Anthropic (ANTHROPIC_API_KEY); deployed default: Bedrock.
 */

import { parseArgs } from "node:util";
import { init } from "./init.js";
import { build } from "./build.js";
import { startDevWatch } from "./dev.js";
import { deploy } from "./deploy.js";
import { runsList, runsGet, runsTail, runsApprove, runsResume } from "./runs.js";
import type { RunId } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `
platine — draht agent framework CLI

USAGE
  platine <command> [options]

COMMANDS
  init [name] [-t workflow]
    Scaffold a new agent directory with agent.md, workflow.ts, tools/, sst.ts.
    Options:
      -t, --template <name>   Template variant (default: "workflow")

  build [options]
    Typecheck and compile workflow.ts → .platine/manifest.json.
    Options:
      --dir <path>            Agent directory (default: cwd)
      --skip-typecheck        Skip tsc --noEmit

  dev [options]
    Run the workflow in-process (no sst dev). Hot-reload on file changes.
    Options:
      --dir <path>            Agent directory (default: cwd)

  deploy [options]
    Build then run sst deploy.
    Options:
      --dir <path>            Agent directory (default: cwd)
      --stage <stage>         SST stage
      --region <region>       AWS region
      --skip-typecheck        Skip tsc --noEmit

  runs <subcommand> [options]
    Manage workflow runs.

    runs list [options]
      --table <name>          DynamoDB table name (or DRAHT_TABLE env)
      --status <status>       Filter by run status
      --limit <n>             Max results
      --local                 Read from .platine/dev-runs/ (local dev mode)
      --dir <path>            Agent directory (default: cwd)

    runs get --run-id <id> [options]
      --table <name>, --local, --dir

    runs tail --run-id <id> [options]
      --table <name>, --local, --dir
      --poll-ms <ms>          Poll interval (default: 1000)
      --timeout-ms <ms>       Max wait (default: 60000)

    runs approve --run-id <id> --action-id <id> [options]
      --decision approved|rejected
      --by <name>
      --table <name>

    runs resume --run-id <id> [options]
      --table <name>

OPTIONS
  --help, -h    Show this help

ENVIRONMENT
  ANTHROPIC_API_KEY     Use Anthropic model in dev mode
  DRAHT_MODEL_PROVIDER  "anthropic" or "bedrock" (overrides auto-detect)
  DRAHT_MODEL_ID        Model identifier string
  DRAHT_TABLE           DynamoDB table name
  DRAHT_QUEUE_URL       SQS queue URL (for runs approve/resume)
  DRAHT_LOCAL           "true" to use local dev-runs storage
`.trim();

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP + "\n");
    return;
  }

  const command = argv[0] as string;
  const rest = argv.slice(1);

  switch (command) {
    case "init":
      await runInit(rest);
      break;
    case "build":
      await runBuild(rest);
      break;
    case "dev":
      await runDev(rest);
      break;
    case "deploy":
      await runDeploy(rest);
      break;
    case "runs":
      await runRuns(rest);
      break;
    default:
      process.stderr.write(`platine: unknown command "${command}"\n\nRun "platine --help" for usage.\n`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function runInit(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      template: { type: "string", short: "t" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values["help"]) {
    process.stdout.write(
      "platine init [name] [-t workflow]\n\nScaffold a new agent directory.\n"
    );
    return;
  }

  const name = positionals[0];
  const template = (values["template"] as string | undefined) ?? "workflow";

  const initOpts: import("./init.js").InitOptions = { template };
  if (name !== undefined) initOpts.name = name;

  const result = await init(initOpts);

  process.stdout.write(
    `✓ Created agent directory: ${result.dir}\n` +
      result.files.map((f) => `  ${f}`).join("\n") +
      "\n\nNext steps:\n" +
      `  cd ${result.dir}\n` +
      `  # Edit agent.md and workflow.ts\n` +
      `  platine dev\n`
  );
}

async function runBuild(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      "skip-typecheck": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values["help"]) {
    process.stdout.write(
      "platine build [--dir <path>] [--skip-typecheck]\n\nCompile workflow.ts → .platine/manifest.json.\n"
    );
    return;
  }

  const dirVal = values["dir"] as string | undefined;
  const skipTypecheck = Boolean(values["skip-typecheck"]);

  process.stdout.write("[platine build] Compiling...\n");

  try {
    const buildOpts: import("./build.js").BuildOptions = { skipTypecheck };
    if (dirVal !== undefined) buildOpts.dir = dirVal;
    const result = await build(buildOpts);
    process.stdout.write(
      `✓ Manifest written: ${result.manifestPath}\n` +
        `  agentId: ${result.manifest.agent.agentId}\n` +
        `  revision: ${result.manifest.revision}\n` +
        `  nodes: ${result.manifest.nodes.length}\n` +
        `✓ Executor entry written: ${result.entryPath}\n`
    );
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runDev(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: false,
  });

  if (values["help"]) {
    process.stdout.write(
      "platine dev [--dir <path>]\n\nRun the workflow in-process with hot-reload.\n"
    );
    return;
  }

  const dirVal2 = values["dir"] as string | undefined;

  process.stdout.write(
    "[platine dev] Starting dev server (in-process, no sst dev)...\n" +
      "[platine dev] Watching for file changes. Press Ctrl+C to stop.\n"
  );

  try {
    const devOpts: import("./dev.js").DevOptions = {};
    if (dirVal2 !== undefined) devOpts.dir = dirVal2;
    const session = await startDevWatch(devOpts);

    // Graceful shutdown
    const cleanup = (): void => {
      process.stdout.write("\n[platine dev] Stopping...\n");
      if (session.stopWatch) session.stopWatch();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    process.stdout.write(
      `[platine dev] Ready. Agent: ${session.manifest.agent.agentId} (revision: ${session.manifest.revision})\n` +
        `[platine dev] Submit runs via the LocalRuntime API or a test harness.\n`
    );

    // Keep the process alive
    await new Promise<never>(() => undefined);
  } catch (err: unknown) {
    process.stderr.write(`[platine dev] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runDeploy(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      dir: { type: "string" },
      stage: { type: "string" },
      region: { type: "string" },
      "skip-typecheck": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values["help"]) {
    process.stdout.write(
      "platine deploy [--dir <path>] [--stage <stage>] [--region <region>]\n\nBuild then sst deploy.\n"
    );
    return;
  }

  const dirDeploy = values["dir"] as string | undefined;
  const stage = values["stage"] as string | undefined;
  const region = values["region"] as string | undefined;
  const skipTypecheck = Boolean(values["skip-typecheck"]);
  const extraArgs = positionals;

  process.stdout.write("[platine deploy] Building...\n");

  try {
    const deployOpts: import("./deploy.js").DeployOptions = { skipTypecheck };
    if (dirDeploy !== undefined) deployOpts.dir = dirDeploy;
    if (stage !== undefined) deployOpts.stage = stage;
    if (region !== undefined) deployOpts.region = region;
    if (extraArgs.length > 0) deployOpts.extraArgs = extraArgs;
    const result = await deploy(deployOpts);

    if (result.exitCode !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    }

    process.stdout.write(result.stdout);
    process.stdout.write("✓ Deployed successfully.\n");
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runRuns(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(
      "platine runs <subcommand>\n\nSubcommands: list, get, tail, approve, resume\n"
    );
    return;
  }

  const subcommand = args[0] as string;
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "list":
      await runRunsList(subArgs);
      break;
    case "get":
      await runRunsGet(subArgs);
      break;
    case "tail":
      await runRunsTail(subArgs);
      break;
    case "approve":
      await runRunsApprove(subArgs);
      break;
    case "resume":
      await runRunsResume(subArgs);
      break;
    default:
      process.stderr.write(
        `platine runs: unknown subcommand "${subcommand}"\n` +
          `Subcommands: list, get, tail, approve, resume\n`
      );
      process.exit(1);
  }
}

async function runRunsList(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      table: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      local: { type: "boolean" },
      dir: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const limitStr = values["limit"] as string | undefined;
  const limit = limitStr !== undefined ? parseInt(limitStr, 10) : undefined;
  const listTable = values["table"] as string | undefined;
  const listStatus = values["status"] as string | undefined;
  const listDir = values["dir"] as string | undefined;

  try {
    const listOpts: import("./runs.js").RunsListOptions = { local: Boolean(values["local"]) };
    if (listTable !== undefined) listOpts.table = listTable;
    if (listStatus !== undefined) listOpts.status = listStatus;
    if (limit !== undefined) listOpts.limit = limit;
    if (listDir !== undefined) listOpts.dir = listDir;
    const { runs } = await runsList(listOpts);

    if (runs.length === 0) {
      process.stdout.write("No runs found.\n");
      return;
    }

    for (const run of runs) {
      process.stdout.write(
        `${run.runId}  status=${run.status}  agent=${run.manifestId}  rev=${run.manifestRevision}\n`
      );
    }
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runRunsGet(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "run-id": { type: "string" },
      table: { type: "string" },
      local: { type: "boolean" },
      dir: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const runId = values["run-id"] as string | undefined;
  if (!runId) {
    process.stderr.write("platine runs get: --run-id is required\n");
    process.exit(1);
  }

  const getTable = values["table"] as string | undefined;
  const getDir = values["dir"] as string | undefined;

  try {
    const getOpts: import("./runs.js").RunsGetOptions = {
      runId: runId as RunId,
      local: Boolean(values["local"]),
    };
    if (getTable !== undefined) getOpts.table = getTable;
    if (getDir !== undefined) getOpts.dir = getDir;
    const { run } = await runsGet(getOpts);

    if (!run) {
      process.stdout.write(`Run not found: ${runId}\n`);
      return;
    }

    process.stdout.write(JSON.stringify(run, null, 2) + "\n");
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runRunsTail(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "run-id": { type: "string" },
      table: { type: "string" },
      local: { type: "boolean" },
      dir: { type: "string" },
      "poll-ms": { type: "string" },
      "timeout-ms": { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const runId = values["run-id"] as string | undefined;
  if (!runId) {
    process.stderr.write("platine runs tail: --run-id is required\n");
    process.exit(1);
  }

  const pollMsStr = values["poll-ms"] as string | undefined;
  const timeoutMsStr = values["timeout-ms"] as string | undefined;
  const tailTable = values["table"] as string | undefined;
  const tailDir = values["dir"] as string | undefined;

  try {
    process.stdout.write(`Tailing run ${runId}...\n`);
    const tailOpts: import("./runs.js").RunsTailOptions = {
      runId: runId as RunId,
      local: Boolean(values["local"]),
    };
    if (tailTable !== undefined) tailOpts.table = tailTable;
    if (tailDir !== undefined) tailOpts.dir = tailDir;
    if (pollMsStr !== undefined) tailOpts.pollMs = parseInt(pollMsStr, 10);
    if (timeoutMsStr !== undefined) tailOpts.timeoutMs = parseInt(timeoutMsStr, 10);
    const result = await runsTail(tailOpts);

    process.stdout.write(JSON.stringify(result.run, null, 2) + "\n");
    if (result.timedOut) {
      process.stderr.write(`[platine runs tail] Timed out waiting for terminal status.\n`);
    }
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runRunsApprove(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "run-id": { type: "string" },
      "action-id": { type: "string" },
      decision: { type: "string" },
      by: { type: "string" },
      table: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const runId = values["run-id"] as string | undefined;
  const actionId = values["action-id"] as string | undefined;
  const decision = values["decision"] as string | undefined;

  if (!runId) { process.stderr.write("platine runs approve: --run-id is required\n"); process.exit(1); }
  if (!actionId) { process.stderr.write("platine runs approve: --action-id is required\n"); process.exit(1); }
  if (decision !== "approved" && decision !== "rejected") {
    process.stderr.write('platine runs approve: --decision must be "approved" or "rejected"\n');
    process.exit(1);
  }

  const approveTable = values["table"] as string | undefined;
  const approveBy = values["by"] as string | undefined;

  try {
    const approveOpts: import("./runs.js").RunsApproveOptions = {
      runId: runId as RunId,
      actionId,
      decision,
    };
    if (approveTable !== undefined) approveOpts.table = approveTable;
    if (approveBy !== undefined) approveOpts.by = approveBy;
    const result = await runsApprove(approveOpts);
    process.stdout.write(`✓ Approval ${decision}. Run status: ${result.status}\n`);
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function runRunsResume(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "run-id": { type: "string" },
      table: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
  });

  const runId = values["run-id"] as string | undefined;
  if (!runId) {
    process.stderr.write("platine runs resume: --run-id is required\n");
    process.exit(1);
  }

  const resumeTable = values["table"] as string | undefined;

  try {
    const resumeOpts: import("./runs.js").RunsResumeOptions = { runId: runId as RunId };
    if (resumeTable !== undefined) resumeOpts.table = resumeTable;
    const result = await runsResume(resumeOpts);
    process.stdout.write(`✓ Resumed. Run status: ${result.status}\n`);
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  process.stderr.write(`platine: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Re-export public API for programmatic use
export { init } from "./init.js";
export { build } from "./build.js";
export { createDevSession, startDevWatch } from "./dev.js";
export { deploy } from "./deploy.js";
export { runsList, runsGet, runsTail, runsApprove, runsResume } from "./runs.js";
