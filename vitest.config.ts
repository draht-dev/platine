// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run all test files under packages/**
    include: ["packages/*/src/**/*.test.ts", "packages/*/src/**/*.spec.ts"],
    // P0 note: no tests yet — packages are stubs. P1+ will add tests per package.
    // passWithNoTests: true — don't fail when no test files exist yet.
    passWithNoTests: true,
  },
});
