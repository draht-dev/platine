// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { drahtAliases } from "../vitest.shared.js";

// @draht/conformance — offline unit tests only (sst-outputs, teardown planning,
// checks registry). NEVER touches AWS: real network/AWS calls live in harness.ts
// and are exercised only via `pnpm conformance:real-aws`, never via `vitest run`.
export default defineConfig({
  resolve: { alias: drahtAliases(resolve(__dirname, "..")) },
  test: {
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
