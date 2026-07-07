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
    // paths:{} clears the base @draht/* → source aliases so the DTS worker
    // resolves sibling packages via dist .d.ts. composite:false avoids TS6307.
    compilerOptions: { composite: false, paths: {} },
  },
  clean: true,
  treeshake: true,
  sourcemap: true,
  // Do NOT bundle @aws-sdk/* or electrodb — these are runtime deps resolved at deploy time.
  // @aws-sdk/client-bedrock-runtime and @anthropic-ai/sdk are optionalDependencies reached
  // ONLY via lazy `await import()` in resolve-model.ts — keep them external too so a
  // consumer without one of the two providers installed doesn't need the other's SDK.
  external: [
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-eventbridge",
    "@aws-sdk/client-sqs",
    "@aws-sdk/lib-dynamodb",
    "@aws-sdk/client-bedrock-runtime",
    "@anthropic-ai/sdk",
    "electrodb",
  ],
});
