// SPDX-License-Identifier: Apache-2.0
/**
 * workflow.ts — bundling-seam fixture (make-executor.bundle.test.ts).
 * Imports the marker tool via a NodeNext `.js` specifier — the same shape
 * `platine build`'s emitted `.platine/executor.entry.ts` relies on esbuild
 * resolving statically.
 */

import { z } from "zod/v4";
import { defineWorkflow } from "@draht/core/define-workflow";
import { markerTool } from "./tools/marker-tool.js";

const _wf = defineWorkflow((b) => {
  const trigger = b.trigger({
    type: "manual",
    payload: z.object({ name: z.string() }),
  });

  const greeted = b.node(markerTool, trigger, (p) => ({ name: p.name }));

  return b.output(greeted);
});

export default {
  ..._wf,
  compile: () =>
    _wf.compile({
      agentId: "bundle-fixture-agent",
      name: "Bundle Fixture Agent",
      model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
      instructions: "Bundle-seam fixture agent.",
    }),
};
