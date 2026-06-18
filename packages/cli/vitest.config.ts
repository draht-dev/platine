// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";
import { drahtAliases } from "../../vitest.shared";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: drahtAliases(__dirname + "/../..") },
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
