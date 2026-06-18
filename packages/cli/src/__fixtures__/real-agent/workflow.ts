// SPDX-License-Identifier: Apache-2.0
/**
 * workflow.ts — fixture for CLI end-to-end tests.
 *
 * Imports the greet tool using a NodeNext .js specifier — this is the
 * pattern that previously caused "Cannot find module './tools/greet.js'"
 * when loaded without tsx.  After the tsx fix it must load cleanly.
 */

import { z } from "zod/v4";
import { defineWorkflow } from "@draht/core/define-workflow";
import { greet } from "./tools/greet.js";

const _wf = defineWorkflow((b) => {
  const trigger = b.trigger({
    type: "manual",
    payload: z.object({ name: z.string() }),
  });

  const greeted = b.node(greet, trigger, (p) => ({ name: p.name }));

  return b.output(greeted);
});

export default {
  ..._wf,
  compile: () =>
    _wf.compile({
      agentId: "fixture-greet-agent",
      name: "Fixture Greet Agent",
      model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
      instructions: "Greet users.",
    }),
};
