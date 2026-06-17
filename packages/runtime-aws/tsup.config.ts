// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "tsup";

export default defineConfig({
  // Two subpath entries: "." and "./handlers"
  // IMPORTANT: Do NOT pre-bundle handlers — SST's esbuild bundles them at deploy.
  // The ./handlers subpath must be require.resolve()-able from the published package.
  entry: {
    index: "src/index.ts",
    "handlers/index": "src/handlers/index.ts",
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
  // Do NOT bundle @aws-sdk/* or electrodb — these are runtime deps resolved at deploy time.
  external: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-eventbridge",
    "@aws-sdk/client-sqs",
    "@aws-sdk/lib-dynamodb",
    "electrodb",
  ],
});
