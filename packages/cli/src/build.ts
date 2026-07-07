// SPDX-License-Identifier: Apache-2.0
/**
 * build.ts — typecheck then compile an agent dir to .platine/manifest.json.
 *
 * Steps:
 *   1. `tsc --noEmit` on the agent directory (typechecks workflow.ts + tools/).
 *   2. Dynamically import workflow.ts (via tsx so .ts + NodeNext .js specifiers work).
 *   3. Validate via parseManifest (round-trip check).
 *   4. Write .platine/manifest.json (pretty-printed).
 *
 * The tsc step is OPTIONAL when `skipTypecheck: true` — used by tests that
 * don't have a full tsconfig in the temp dir.
 *
 * tsx is used for step 2 so the agent's workflow.ts (which is TypeScript and
 * may use NodeNext `.js`-extension imports) can be loaded at runtime without
 * a separate compile step.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseManifest } from "@draht/manifest";
import type { Manifest } from "@draht/manifest";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Directory containing workflow.ts (defaults to process.cwd()). */
  dir?: string;
  /** Skip `tsc --noEmit` step. Default: false. */
  skipTypecheck?: boolean;
  /** Write the manifest to disk. Default: true. */
  write?: boolean;
}

export interface BuildResult {
  /** The parsed, validated Manifest. */
  manifest: Manifest;
  /** Path to the written manifest.json (empty string if write:false). */
  manifestPath: string;
  /** Path to the written .platine/executor.entry.ts (empty string if write:false). */
  entryPath: string;
}

/**
 * Run a full build: typecheck → compile → validate → write manifest.
 */
export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const dir = resolve(opts.dir ?? process.cwd());
  const skipTypecheck = opts.skipTypecheck ?? false;
  const shouldWrite = opts.write ?? true;

  // -------------------------------------------------------------------------
  // 1. tsc --noEmit typecheck (using the workspace-local TypeScript, not PATH)
  // -------------------------------------------------------------------------
  if (!skipTypecheck) {
    // Resolve the local TypeScript compiler so we don't depend on a global tsc.
    let tscPath: string;
    try {
      tscPath = require.resolve("typescript/bin/tsc");
    } catch {
      throw new Error(
        `[platine build] Cannot resolve typescript/bin/tsc. ` +
          `Ensure "typescript" is installed in the project or workspace.`
      );
    }

    const result = spawnSync(
      process.execPath,
      [tscPath, "--noEmit", "--project", join(dir, "tsconfig.json")],
      {
        cwd: dir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    if (result.error) {
      throw new Error(
        `[platine build] tsc failed to spawn: ${result.error.message}`
      );
    }

    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      const stdout = (result.stdout ?? "").trim();
      const output = [stdout, stderr].filter(Boolean).join("\n");
      throw new Error(
        `[platine build] tsc --noEmit failed with exit code ${result.status ?? "null"}:\n${output}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // 2. Dynamically import workflow.ts via tsx
  //    tsx's tsImport transpiles .ts on the fly and resolves NodeNext .js→.ts
  //    specifiers, so both TypeScript syntax and .js-extension imports work.
  // -------------------------------------------------------------------------
  const workflowPath = join(dir, "workflow.ts");
  const workflowUrl = pathToFileURL(workflowPath).href;

  let workflowModule: unknown;
  try {
    // Import tsx programmatic API lazily so build() works without tsx when
    // the workflow.ts is plain JS-compatible (e.g. in some test scenarios).
    // We always use tsImport here to correctly support real TS agent dirs.
    const { tsImport } = await import("tsx/esm/api");
    // parentURL must be a file: URL; any valid one works — we use a sentinel
    // so tsx resolves relative imports inside workflow.ts from `dir`.
    workflowModule = await tsImport(workflowUrl, {
      parentURL: pathToFileURL(join(dir, "_platine_build_entry.ts")).href,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[platine build] Failed to import workflow.ts from ${workflowPath}:\n${msg}`
    );
  }

  // -------------------------------------------------------------------------
  // 3. Get the default export and call .compile()
  // -------------------------------------------------------------------------
  const mod = workflowModule as Record<string, unknown>;
  let defaultExport = mod["default"];

  if (defaultExport === null || defaultExport === undefined) {
    throw new Error(
      `[platine build] workflow.ts must have a default export (the result of defineWorkflow(...)).`
    );
  }

  // tsx's CJS↔ESM interop double-wraps the default export ({ default: { default: wf } })
  // when the agent dir lacks a package.json "type":"module". Unwrap one level so
  // `platine build` works regardless of the dir's module-type resolution.
  if (
    typeof (defaultExport as { compile?: unknown }).compile !== "function" &&
    typeof defaultExport === "object" &&
    typeof (defaultExport as { default?: { compile?: unknown } }).default === "object" &&
    typeof (defaultExport as { default?: { compile?: unknown } }).default?.compile === "function"
  ) {
    defaultExport = (defaultExport as { default: unknown }).default;
  }

  const workflowDef = defaultExport as { compile?: (opts?: unknown) => Manifest };

  if (typeof workflowDef.compile !== "function") {
    throw new Error(
      `[platine build] The default export of workflow.ts must be a WorkflowDef ` +
        `(has a .compile() method). Got: ${typeof defaultExport}.`
    );
  }

  const raw: Manifest = workflowDef.compile();

  // -------------------------------------------------------------------------
  // 4. Validate via parseManifest (round-trip)
  // -------------------------------------------------------------------------
  const manifest = parseManifest(JSON.parse(JSON.stringify(raw)));

  // -------------------------------------------------------------------------
  // 5. Write .platine/manifest.json + .platine/executor.entry.ts
  // -------------------------------------------------------------------------
  let manifestPath = "";
  let entryPath = "";
  if (shouldWrite) {
    const platineDir = join(dir, ".platine");
    await mkdir(platineDir, { recursive: true });
    manifestPath = join(platineDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    // .platine/executor.entry.ts — STATICALLY imports the agent's workflow.ts
    // so esbuild (tsup locally / SST at deploy) bundles the user's tool
    // execute() closures into the Lambda artifact. makeExecutorHandler builds
    // a RealToolsDispatcher from the WorkflowDef's tool registry at runtime.
    entryPath = join(platineDir, "executor.entry.ts");
    const entrySource =
      "// AUTO-GENERATED by `platine build`. Do not edit.\n" +
      "import workflow from \"../workflow.js\";\n" +
      "import { makeExecutorHandler } from \"@draht/runtime-aws\";\n" +
      "\n" +
      "export const handler = makeExecutorHandler({ workflow });\n";
    await writeFile(entryPath, entrySource, "utf8");
  }

  return { manifest, manifestPath, entryPath };
}
