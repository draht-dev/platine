// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";
import { drahtAliases } from "../../vitest.shared";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: drahtAliases(resolve(__dirname, "../..")) },
  test: {
    include: ["*.test.ts"],
    passWithNoTests: true,
  },
});
