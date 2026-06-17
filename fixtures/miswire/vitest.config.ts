// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const root = resolve(__dirname, "../..");

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    passWithNoTests: false,
  },
  resolve: {
    alias: {
      // Resolve @draht/core subpaths to the built dist (not source) so the
      // TypeScript compiler API program uses the same types the fixture files see.
      "@draht/core/define-tool": resolve(root, "packages/core/dist/define-tool.js"),
      "@draht/core/define-agent": resolve(root, "packages/core/dist/define-agent.js"),
      "@draht/core/define-workflow": resolve(root, "packages/core/dist/define-workflow.js"),
      "@draht/core/manifest": resolve(root, "packages/core/dist/manifest/index.js"),
      "@draht/core/seams": resolve(root, "packages/core/dist/seams/index.js"),
      "@draht/core/compile": resolve(root, "packages/core/dist/compile.js"),
    },
  },
});
