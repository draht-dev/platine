// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    // composite:true in tsconfig is for `tsc -b` project references; override to
    // false here so tsup's rollup DTS worker does not emit TS6307.
    // The tsconfig keeps composite:true for tsc --noEmit.
    //
    // paths: {} clears the source-level alias "@draht/manifest" →
    // "../manifest/src/index.ts" that lives outside rootDir "src" and would
    // trigger TS6059 in the DTS worker.  Without the override tsup resolves
    // @draht/manifest through node_modules (→ dist/index.d.ts) which is
    // correct for declaration-file generation.
    compilerOptions: { composite: false, paths: {} },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
});
