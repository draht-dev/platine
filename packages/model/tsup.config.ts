// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    // paths:{} clears the base @draht/* → source aliases so the DTS worker
    // resolves sibling packages via dist .d.ts. composite:false avoids TS6307.
    compilerOptions: { composite: false, paths: {} },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
});
