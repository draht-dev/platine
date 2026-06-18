// SPDX-License-Identifier: Apache-2.0
/**
 * greet tool — fixture for CLI end-to-end tests.
 * Uses a NodeNext-style .js specifier for the import of define-tool,
 * which is the style that broke before the tsx fix.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";

export const greet = defineTool({
  description: "Greet a user by name.",

  inputSchema: z.object({
    name: z.string().describe("The name to greet."),
  }),

  outputSchema: z.object({
    greeting: z.string(),
  }),

  execute: async ({ name }) => ({
    greeting: `Hello, ${name}!`,
  }),
});
