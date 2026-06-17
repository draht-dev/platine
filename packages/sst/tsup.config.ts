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
    compilerOptions: { composite: false },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
});
