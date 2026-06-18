// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { drahtAliases } from "../../vitest.shared.js";

export default defineConfig({
  resolve: { alias: drahtAliases(resolve(__dirname, "../..")) },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    passWithNoTests: false,
  },
});
