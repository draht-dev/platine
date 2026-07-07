// SPDX-License-Identifier: Apache-2.0
/**
 * marker-tool.ts — bundling-seam fixture (make-executor.bundle.test.ts).
 *
 * The execute() body below contains a unique marker string. The bundle test
 * asserts this literal string is present in the esbuild output, proving that
 * a STATIC import of a workflow (as `platine build` emits in
 * `.platine/executor.entry.ts`) causes the user's tool `execute()` closure to
 * actually land in the Lambda bundle — NOT just a reference to it.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";

export const BUNDLE_MARKER = "BUNDLE_SEAM_MARKER_9f3a2c7e";

export const markerTool = defineTool({
  description: "bundling-seam fixture tool",

  inputSchema: z.object({
    name: z.string(),
  }),

  outputSchema: z.object({
    greeting: z.string(),
  }),

  execute: async ({ name }) => {
    // BUNDLE_SEAM_MARKER_9f3a2c7e — this literal must survive into the esbuild bundle.
    return { greeting: `BUNDLE_SEAM_MARKER_9f3a2c7e:${name}` };
  },
});
