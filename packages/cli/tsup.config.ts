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
    dts: true,
    clean: false,
    treeshake: true,
    sourcemap: true,
  },
]);
