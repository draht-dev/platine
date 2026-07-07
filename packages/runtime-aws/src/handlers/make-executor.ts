// SPDX-License-Identifier: Apache-2.0
/**
 * handlers/make-executor.ts — per-agent executor Lambda factory.
 *
 * `platine build` emits a per-agent entry (`.platine/executor.entry.ts`) that
 * STATICALLY imports the user's workflow.ts and calls
 * `makeExecutorHandler({ workflow })`. Because the import is static, esbuild
 * (tsup locally / SST at deploy) bundles the user's tool `execute()` closures
 * into the Lambda artifact — see make-executor.bundle.test.ts for the proof.
 *
 * makeExecutorHandler builds a RealToolsDispatcher from the WorkflowDef's tool
 * registry (buildToolRegistry) so tool nodes actually run the user's business
 * logic instead of the legacy handler's StubToolsDispatcher `{}` placeholder.
 */

import type { WorkflowDef } from "@draht/core/define-workflow";
import { buildToolRegistry } from "@draht/core/compile";
import { parseManifest } from "@draht/core/manifest";
import type { Model, Storage } from "@draht/core/seams";
import type { ExecutorDeps } from "../executor.js";
import { RealToolsDispatcher } from "../tools-dispatcher.js";
import { resolveModelFromEnv } from "../resolve-model.js";
import { buildAwsDeps, driveRecords, type SQSEvent, type LambdaContext } from "./deps.js";

export interface MakeExecutorOptions {
  /** The agent's compiled workflow — statically imported so esbuild bundles its tools. */
  workflow: WorkflowDef;
  /** Inject a Model (tests / non-default providers). Defaults to resolveModelFromEnv(). */
  model?: Model;
}

export type ExecutorLambdaHandler = (event: SQSEvent, context: LambdaContext) => Promise<void>;

/**
 * wrapStorageWithToolRegistryCheck — SHOULD-FIX 3b: cross-check the run's
 * PINNED manifest's `tools[].toolId` set against the bundled tool registry
 * BEFORE any node of that run is dispatched.
 *
 * Why here, and why on loadManifest(): the manifest isn't available at
 * `makeExecutorHandler()` construction time (only the WorkflowDef/registry
 * is) — it's only known once drive() loads the run's PINNED manifest
 * revision, which is the very first thing drive() does with the manifest,
 * before its scheduling loop runs any node. Intercepting loadManifest() lets
 * us validate at that exact point, per run, per SQS record — so a
 * registry/manifest mismatch (e.g. the wrong workflow.ts got bundled, or a
 * tool was renamed/removed without a manifest revision bump) throws a loud,
 * descriptive error INSIDE driveRecords' per-record try/catch (so only that
 * record DLQs, with a clear message) instead of silently letting earlier
 * tool nodes in the run dispatch (real side effects!) before a LATER node's
 * missing-tool dispatch finally throws mid-run.
 *
 * Memoized per (manifestId, revision) so repeated drive() calls for the same
 * pinned manifest (redelivery, continuations, fanout batches) don't re-parse
 * and re-diff on every call.
 */
export function wrapStorageWithToolRegistryCheck(
  storage: Storage,
  registry: Map<string, unknown>,
): Storage {
  const checkedManifests = new Set<string>();
  // A Proxy (not object-spread) is required here: Storage implementations
  // (e.g. DynamoStorage) define their methods on the class prototype, not as
  // own instance properties, so `{ ...storage, loadManifest: ... }` would
  // silently drop every other method. The Proxy transparently forwards
  // everything except the one method we intercept.
  return new Proxy(storage, {
    get(target, prop, receiver): unknown {
      if (prop === "loadManifest") {
        return async (manifestId: string, revision: string): Promise<string> => {
          const blob = await target.loadManifest(manifestId, revision);
          const key = `${manifestId}#${revision}`;
          if (!checkedManifests.has(key)) {
            const manifest = parseManifest(JSON.parse(blob) as unknown);
            const missing = manifest.tools
              .map((t) => t.toolId)
              .filter((toolId) => !registry.has(toolId));
            if (missing.length > 0) {
              throw new Error(
                `[executor] tool registry is missing ${missing.length} tool(s) pinned by ` +
                  `manifest ${manifestId}@${revision}: ${missing.join(", ")}. ` +
                  `Registered tools: ${[...registry.keys()].join(", ") || "(none)"}. ` +
                  `This means the bundled workflow.ts no longer matches the deployed ` +
                  `manifest revision — redeploy after reconciling the workflow's tools.`,
              );
            }
            checkedManifests.add(key);
          }
          return blob;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

/**
 * makeExecutorHandler — factory returning an SQS-triggered Lambda handler
 * wired to the given WorkflowDef's real tool registry.
 */
export function makeExecutorHandler(opts: MakeExecutorOptions): ExecutorLambdaHandler {
  const registry = buildToolRegistry(opts.workflow);
  const tools = new RealToolsDispatcher(registry);

  // TRIVIAL CONSIDERS: memoize resolveModelFromEnv() at factory scope (once
  // per cold start), matching resolve-model.ts's "fails fast at cold start"
  // doc claim. Deliberately NOT resolved eagerly here (at makeExecutorHandler
  // construction / module init) — resolveModelFromEnv() does real SDK client
  // construction that we don't want to run at import time in tests/build
  // tooling that only need the handler's shape, and SQS Lambda cold starts
  // already pay this cost once on the FIRST invocation's model resolution
  // (subsequent invocations on a warm container reuse the cached promise).
  // A cold-start (module-init-time) throw would fail EVERY record in that
  // cold start's batch uniformly; a first-record throw (this choice) is
  // caught by driveRecords' per-record try/catch, so it DLQs just that
  // record with a clear message — consistent with BLOCKER 1's fix, which
  // also relies on the per-record catch to surface a clear error rather than
  // poisoning the whole batch.
  let modelPromise: Promise<Model> | undefined;
  function resolveModelOnce(): Promise<Model> {
    if (opts.model !== undefined) return Promise.resolve(opts.model);
    if (modelPromise === undefined) {
      modelPromise = resolveModelFromEnv();
    }
    return modelPromise;
  }

  return async function executorLambdaHandler(
    event: SQSEvent,
    context: LambdaContext,
  ): Promise<void> {
    const base = buildAwsDeps();
    const model = await resolveModelOnce();
    const storage = wrapStorageWithToolRegistryCheck(base.storage, registry);
    const deps: ExecutorDeps = { ...base, storage, model, tools };

    await driveRecords(event, context, deps);
  };
}
