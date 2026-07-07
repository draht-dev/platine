// SPDX-License-Identifier: Apache-2.0
/**
 * make-executor.bundle.test.ts — TASK 1.1: proves the bundling seam.
 *
 * `platine build` emits a per-agent entry (`.platine/executor.entry.ts`) that
 * STATICALLY imports the user's workflow.ts and calls makeExecutorHandler().
 * This test proves that a static import is enough for esbuild to bundle the
 * user's tool `execute()` closure into the Lambda artifact — by generating a
 * temp entry (matching the real generated-entry shape) that imports a fixture
 * workflow + makeExecutorHandler, running `esbuild.build({bundle:true, ...})`
 * on it, and asserting the fixture tool's execute-body marker string is
 * present in the output.
 *
 * If this assertion fails, the whole "bundle tools into the Lambda" mechanism
 * is broken at its foundation — see the plan's TASK 1.1 STOP/BLOCKED gate.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { BUNDLE_MARKER } from "../__fixtures__/bundle-workflow/tools/marker-tool.js";

describe("make-executor — bundling seam (TASK 1.1)", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("statically bundles the fixture tool's execute() body via esbuild", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-bundle-test-"));
    created.push(tmp);

    // Absolute paths so the generated entry's imports don't depend on where
    // the temp dir happens to sit relative to any node_modules tree.
    const runtimeAwsIndex = resolve(import.meta.dirname, "..", "index.ts");
    const fixtureWorkflow = resolve(
      import.meta.dirname,
      "..",
      "__fixtures__",
      "bundle-workflow",
      "workflow.ts",
    );

    // Mirrors the shape `platine build` writes to `.platine/executor.entry.ts`:
    //   import workflow from "../workflow.js";
    //   import { makeExecutorHandler } from "@draht/runtime-aws";
    //   export const handler = makeExecutorHandler({ workflow });
    const entryPath = join(tmp, "executor.entry.ts");
    await writeFile(
      entryPath,
      [
        `import workflow from ${JSON.stringify(fixtureWorkflow)};`,
        `import { makeExecutorHandler } from ${JSON.stringify(runtimeAwsIndex)};`,
        `export const handler = makeExecutorHandler({ workflow });`,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      // These are resolved lazily at deploy/runtime (optionalDependencies /
      // peer AWS SDK clients) — not part of what this test is proving.
      external: ["@aws-sdk/*", "@anthropic-ai/sdk", "electrodb"],
    });

    expect(result.outputFiles.length).toBeGreaterThan(0);
    const output = result.outputFiles.map((f) => f.text).join("\n");

    expect(output).toContain(BUNDLE_MARKER);
  });
});
