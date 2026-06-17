// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
  // One entry per exports subpath — NO barrel.
  // @draht/core deliberately exposes ONLY deep subpaths to prevent transitive
  // pulls of node-only deps that would break Next.js/client bundles.
  entry: {
    "define-tool": "src/define-tool.ts",
    "define-agent": "src/define-agent.ts",
    "define-workflow": "src/define-workflow.ts",
    "manifest/index": "src/manifest/index.ts",
    "seams/index": "src/seams/index.ts",
    "compile": "src/compile.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    // composite:true in tsconfig is for `tsc -b` project references; tsup's
    // rollup-based DTS worker creates a synthetic TypeScript program with only
    // the entry file as a root, which causes TS6307 ("not listed within the file
    // list of project") for all transitively-imported source files when composite
    // mode is active.  Override it to false here — the tsconfig itself stays
    // composite:true so `tsc --noEmit` and `tsc -b` continue to work correctly.
    compilerOptions: { composite: false },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
});
