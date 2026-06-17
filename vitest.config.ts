// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { drahtAliases } from "./vitest.shared";

// Workspace-level run: every package's src tests, with @draht/* resolved to source.
export default defineConfig({
  resolve: { alias: drahtAliases(__dirname) },
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.spec.ts"],
    passWithNoTests: true,
  },
});
