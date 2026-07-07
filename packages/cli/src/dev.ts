// SPDX-License-Identifier: Apache-2.0
/**
 * dev.ts — run the workflow IN-PROCESS via LocalRuntime + Memory adapters.
 *
 * Design per §4 and OQ6:
 *   - Does NOT spawn a second `sst dev` multiplexer.
 *   - Runs the SAME executor.ts as production, behind MemoryStorage/Queue/Bus.
 *   - Default model = Anthropic (ANTHROPIC_API_KEY present) else Bedrock
 *     (DRAHT_MODEL_PROVIDER=bedrock or no ANTHROPIC_API_KEY).
 *   - The model string "anthropic/..." vs "bedrock/..." picks the adapter.
 *   - For tests, inject a fake Model via `devOptions.model`.
 *   - Hot-reload: watches workflow.ts + tools/** and re-compiles on change.
 *     reload() REPLACES the runtime/storage with a fresh MemoryStorage/LocalRuntime
 *     pair (not a mutation) — it does NOT preserve in-flight run state. Each
 *     `run()` call snapshots the runtime/storage/manifest it started with into
 *     local consts (see run()'s comment) so a reload() racing with an
 *     in-flight run() completes safely against the generation it started
 *     with, rather than crossing into the NEW runtime/storage mid-flight —
 *     but that run's data then lives only in the now-orphaned pre-reload
 *     MemoryStorage, inaccessible to the session after reload() returns.
 *
 * The `run` export submits one run; `watch` re-compiles on FS change (v1 hot-reload).
 */

import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { watch as fsWatch } from "node:fs";
import type { Model, RunId, RunRecord } from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import { deriveRunId, createLocalRuntime, RealToolsDispatcher } from "@draht/runtime-aws";
import type { LocalRuntimeOptions, ToolsDispatcher } from "@draht/runtime-aws";
import { buildToolRegistry } from "@draht/core/compile";
import type { WorkflowDef } from "@draht/core/define-workflow";
import { parseManifest } from "@draht/manifest";
import type { Manifest } from "@draht/manifest";

// ---------------------------------------------------------------------------
// Model selection (OQ6)
// ---------------------------------------------------------------------------

/**
 * Pick a Model implementation based on environment.
 * OQ6: Anthropic if ANTHROPIC_API_KEY, else Bedrock.
 * For tests, inject via devOptions.model.
 *
 * The real SDK clients are constructed with adapter wrappers so the
 * structural interfaces expected by BedrockModel / AnthropicModel are satisfied.
 */
async function resolveModel(): Promise<Model> {
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  const forceProvider = process.env["DRAHT_MODEL_PROVIDER"];

  if (forceProvider === "bedrock" || (!anthropicKey && forceProvider !== "anthropic")) {
    // Use BedrockModel — adapt the AWS SDK BedrockRuntimeClient to BedrockConverseClient.
    // The structural adapter wraps send(ConverseCommand) → converse() / converseStream().
    const { BedrockModel } = await import("@draht/model");
    const {
      BedrockRuntimeClient,
      ConverseCommand,
      ConverseStreamCommand,
    } = await import("@aws-sdk/client-bedrock-runtime");
    type BCI = import("@draht/model").BedrockConverseClient;
    type ConverseIn = Parameters<BCI["converse"]>[0];
    type ConverseStreamIn = Parameters<BCI["converseStream"]>[0];
    const sdkClient = new BedrockRuntimeClient({});

    // The AWS SDK send() return types don't precisely match the structural
    // BedrockConverseClient interface, so we use `as unknown` to bridge the gap.
    // The underlying method signatures are compatible at runtime.
    const bedrockAdapter: BCI = {
      converse: (input: ConverseIn) =>
        sdkClient.send(new ConverseCommand(input)) as unknown as ReturnType<BCI["converse"]>,
      converseStream: (input: ConverseStreamIn) =>
        sdkClient.send(new ConverseStreamCommand(input)) as unknown as ReturnType<BCI["converseStream"]>,
    };

    return new BedrockModel(bedrockAdapter);
  }

  // Default: Anthropic — the Anthropic SDK client's .messages property satisfies
  // AnthropicMessagesClient structurally (same create/stream signatures).
  const { AnthropicModel } = await import("@draht/model");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const sdkClient = new Anthropic({ apiKey: anthropicKey! });

  // AnthropicModel accepts the full Anthropic client (has .messages property)
  return new AnthropicModel(sdkClient as unknown as import("@draht/model").AnthropicMessagesClient);
}

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

interface LoadedWorkflow {
  /** The raw WorkflowDef — its `.nodes` carry the ToolDef `execute()` closures
   * (never serialized into the Manifest), consumed by buildToolRegistry(). */
  workflowDef: WorkflowDef;
  manifest: Manifest;
}

async function loadWorkflow(dir: string): Promise<LoadedWorkflow> {
  const workflowPath = join(dir, "workflow.ts");
  // tsx's tsImport transpiles .ts on the fly and resolves NodeNext .js→.ts
  // specifiers inside the agent dir.  We add a cache-busting suffix so that
  // hot-reload re-evaluates the module on each call.
  const workflowUrl =
    pathToFileURL(workflowPath).href + `?t=${Date.now()}`;

  let workflowModule: unknown;
  try {
    const { tsImport } = await import("tsx/esm/api");
    workflowModule = await tsImport(workflowUrl, {
      parentURL: pathToFileURL(join(dir, "_platine_dev_entry.ts")).href,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[platine dev] Failed to import workflow.ts from ${workflowPath}:\n${msg}`
    );
  }

  const mod = workflowModule as Record<string, unknown>;
  let defaultExport = mod["default"];

  if (defaultExport === null || defaultExport === undefined) {
    throw new Error(
      `[platine dev] workflow.ts must have a default export (the result of defineWorkflow(...)).`
    );
  }

  // tsx CJS↔ESM interop can double-wrap the default ({ default: { default: wf } })
  // when the agent dir lacks package.json "type":"module"; unwrap one level.
  if (
    typeof (defaultExport as { compile?: unknown }).compile !== "function" &&
    typeof defaultExport === "object" &&
    typeof (defaultExport as { default?: { compile?: unknown } }).default === "object" &&
    typeof (defaultExport as { default?: { compile?: unknown } }).default?.compile === "function"
  ) {
    defaultExport = (defaultExport as { default: unknown }).default;
  }

  const workflowDefLoose = defaultExport as { compile?: () => Manifest };
  if (typeof workflowDefLoose.compile !== "function") {
    throw new Error(
      `[platine dev] The default export of workflow.ts must be a WorkflowDef with .compile().`
    );
  }

  const raw = workflowDefLoose.compile();
  const manifest = parseManifest(JSON.parse(JSON.stringify(raw)));

  return { workflowDef: workflowDefLoose as unknown as WorkflowDef, manifest };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DevOptions {
  /** Directory containing workflow.ts (defaults to process.cwd()). */
  dir?: string;
  /**
   * Inject a fake Model for tests. Skips env-based model resolution.
   * When provided, no real API calls are made.
   */
  model?: Model;
  /**
   * Inject a ToolsDispatcher (e.g. FakeToolsDispatcher) for tests.
   * When omitted, tools dispatch through a RealToolsDispatcher built from the
   * workflow's own tool registry (buildToolRegistry) — the SAME user-authored
   * `execute()` code that runs in the deployed executor Lambda.
   */
  tools?: ToolsDispatcher;
}

export interface DevRunInput {
  /** Trigger input payload. */
  input: Record<string, unknown>;
  /** Optional: override the tenant id. */
  tenantId?: string;
}

export interface DevRunResult {
  /** The run ID (deterministic). */
  runId: RunId;
  /** The run record after draining the queue. */
  run: RunRecord;
}

/**
 * DevSession: a loaded manifest + runtime ready to accept runs.
 * Construct via `createDevSession`.
 */
export interface DevSession {
  /** Current compiled manifest. */
  manifest: Manifest;
  /** Submit and synchronously drain one run. Returns the run record. */
  run(input: DevRunInput): Promise<DevRunResult>;
  /** Reload the workflow from disk (hot-reload). */
  reload(): Promise<void>;
  /** Stop watching (if watch mode was started). */
  stopWatch?: () => void;
}

/**
 * Create a DevSession: compile workflow.ts, instantiate MemoryStorage + LocalRuntime,
 * and return a session that can submit runs.
 */
export async function createDevSession(opts: DevOptions = {}): Promise<DevSession> {
  const dir = resolve(opts.dir ?? process.cwd());

  // Resolve model (fake for tests, real for CLI use)
  const model = opts.model ?? (await resolveModel());

  // Load workflow + manifest
  let { workflowDef, manifest } = await loadWorkflow(dir);

  // Tools: injected (tests) or a RealToolsDispatcher built from the workflow's
  // own tool registry — runs the user's ACTUAL tool execute() code in-process,
  // the same registry-construction scheme the deployed executor Lambda uses.
  let tools: ToolsDispatcher = opts.tools ?? new RealToolsDispatcher(buildToolRegistry(workflowDef));

  const runtimeOpts: LocalRuntimeOptions<ToolsDispatcher> = { model, tools };

  // Create local runtime
  let { runtime, storage } = createLocalRuntime(runtimeOpts);

  const session: DevSession = {
    get manifest() {
      return manifest;
    },

    async run(input: DevRunInput): Promise<DevRunResult> {
      // SHOULD-FIX 6: snapshot the outer `runtime`/`storage`/`manifest` `let`
      // bindings into LOCAL consts BEFORE any `await`. `run()` is async and
      // spans multiple await points (submitRun, drainQueue); reload() can run
      // to completion in between (e.g. the fs-watch debounce firing while a
      // run is mid-flight) and REPLACES (not mutates) `runtime`/`storage` with
      // a fresh MemoryStorage/LocalRuntime pair. Without this snapshot, this
      // run() call would submitRun() against the OLD runtime but then
      // drainQueue()/getRun() against the NEW one — the run would never be
      // found ("Run not found after drain") even though it genuinely ran.
      const activeRuntime = runtime;
      const activeStorage = storage;
      const activeManifest = manifest;

      // Re-snapshot the manifest for this run (so hot-reload doesn't corrupt in-flight runs)
      await activeStorage.putManifest(
        activeManifest.agent.agentId,
        activeManifest.revision,
        JSON.stringify(activeManifest)
      );

      // Derive deterministic runId at boundary
      const triggerSource = `dev:${activeManifest.agent.agentId}`;
      const dedupKey = JSON.stringify(input.input) + Date.now().toString();
      const runId = deriveRunId(triggerSource, dedupKey) as RunId;

      const tenantId = (input.tenantId ?? DEFAULT_TENANT) as import("@draht/core/seams").TenantId;

      await activeRuntime.submitRun({
        runId,
        manifestId: activeManifest.agent.agentId,
        manifestRevision: activeManifest.revision,
        tenantId,
        trigger: {
          type: "manual",
          payload: input.input,
        },
        input: input.input,
        chainDepth: 0,
      });

      // Drain the queue in-process
      await activeRuntime.drainQueue({ deadlineAt: Date.now() + 10 * 60 * 1000 });

      const run = await activeStorage.getRun(tenantId, runId);
      if (!run) {
        throw new Error(`[platine dev] Run ${runId} not found after drain.`);
      }

      return { runId, run };
    },

    async reload(): Promise<void> {
      const loaded = await loadWorkflow(dir);
      workflowDef = loaded.workflowDef;
      manifest = loaded.manifest;

      // Rebuild the default RealToolsDispatcher's registry from the freshly
      // reloaded workflow so hot-reload picks up tool code changes too.
      // An explicitly injected `opts.tools` (tests) is preserved unchanged.
      tools = opts.tools ?? new RealToolsDispatcher(buildToolRegistry(workflowDef));
      runtimeOpts.tools = tools;

      // Create a fresh runtime for the new manifest
      const fresh = createLocalRuntime(runtimeOpts);
      runtime = fresh.runtime;
      storage = fresh.storage;
    },
  };

  return session;
}

/**
 * Start a dev session with hot-reload watch mode.
 * Returns a DevSession with a `stopWatch` cleanup function.
 */
export async function startDevWatch(opts: DevOptions = {}): Promise<DevSession> {
  const dir = resolve(opts.dir ?? process.cwd());
  const session = await createDevSession(opts);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fsWatch(
    dir,
    { recursive: true },
    (event: string, filename: string | null) => {
      if (!filename) return;
      const rel = relative(dir, join(dir, filename));
      // Only reload on .ts file changes
      if (!rel.endsWith(".ts")) return;

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        process.stdout.write(`[platine dev] Reloading (${event}: ${filename})...\n`);
        session.reload().catch((err: unknown) => {
          process.stderr.write(`[platine dev] Reload error: ${String(err)}\n`);
        });
      }, 100);
    }
  );

  session.stopWatch = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };

  return session;
}
