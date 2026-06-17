// SPDX-License-Identifier: Apache-2.0
/**
 * type-mismatch.ts — mapper assigns a value of the wrong type to an input field.
 *
 * The downstream tool expects { count: number } but the mapper returns { count: string }.
 *
 * Expected error: TS2322 — Type 'string' is not assignable to type 'number'.
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const producer = defineTool({
  description: "Produces { label: string }",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ label: z.string() }),
  execute: async ({ body }) => ({ label: body }),
});

const consumer = defineTool({
  description: "Consumes { count: number }",
  inputSchema: z.object({ count: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ body: z.string() }),
  });

  const up = b.node(producer, t, (p) => ({ body: p.body }));

  const _result = b.node(consumer, up, (out) => ({
    count: out.label, // $ExpectError TS2322
  }));

  return b.output(_result);
});
