// SPDX-License-Identifier: Apache-2.0
/**
 * wrong-field.ts — mapper reads a field that does not exist on the upstream output.
 *
 * Expected error: TS2339 — Property 'nope' does not exist on type ...
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const upstream = defineTool({
  description: "Produces { summary: string }",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async ({ body }) => ({ summary: body.slice(0, 80) }),
});

const downstream = defineTool({
  description: "Consumes { subject: string }",
  inputSchema: z.object({ subject: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ body: z.string() }),
  });

  const up = b.node(upstream, t, (p) => ({ body: p.body }));

  const _result = b.node(downstream, up, (out) => ({
    subject: out.nope, // $ExpectError TS2339
  }));

  return b.output(_result);
});
