// SPDX-License-Identifier: Apache-2.0
/**
 * missing-required.ts — mapper return omits a required input field.
 *
 * The downstream tool requires both { subject: string; priority: string } but
 * the mapper only provides { subject: string }, omitting the required `priority`.
 *
 * Expected error: TS2741 — Property 'priority' is missing in type '{ subject: string }'
 *                           but required in type '{ subject: string; priority: string }'.
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const producer = defineTool({
  description: "Produces { summary: string }",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async ({ body }) => ({ summary: body.slice(0, 80) }),
});

const consumer = defineTool({
  description: "Consumes { subject: string; priority: string }",
  inputSchema: z.object({ subject: z.string(), priority: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ body: z.string() }),
  });

  const up = b.node(producer, t, (p) => ({ body: p.body }));

  const _result = b.node(consumer, up, (out) => ({ subject: out.summary })); // $ExpectError TS2741

  return b.output(_result);
});
