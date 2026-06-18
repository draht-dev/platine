// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig([
  {
    // CJS build — the bin entry. tsup banner adds the shebang to the CJS output.
    entry: {
      index: "src/index.ts",
    },
    format: ["cjs"],
    dts: false,
    clean: true,
    treeshake: true,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    // ESM build — no banner (shebang is only needed on the CJS bin)
    entry: {
      index: "src/index.ts",
    },
    format: ["esm"],
    dts: {
      // composite:true in tsconfig is for `tsc -b` project references; override to
      // false here so tsup's rollup DTS worker does not emit TS6307.
      // The tsconfig keeps composite:true for tsc --noEmit.
      //
      // paths: {} clears source-level aliases (e.g. "@draht/model" →
      // "../model/src/index.ts") that live outside rootDir "src" and would
      // trigger TS6059 in the DTS worker. Without the override tsup resolves
      // each package through node_modules (→ dist/index.d.ts) which is
      // correct for declaration-file generation.
      compilerOptions: { composite: false, paths: {} },
    },
    clean: false,
    treeshake: true,
    sourcemap: true,
  },
]);
