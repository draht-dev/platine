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
    // paths:{} clears the base tsconfig's @draht/* → source aliases so the DTS
    // worker resolves sibling packages via their published dist .d.ts (correct
    // for declaration emit). composite:false avoids TS6307 in the rollup worker.
    compilerOptions: { composite: false, paths: {} },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
});
