// SPDX-License-Identifier: Apache-2.0
/**
 * excess-field.ts — mapper return has an extra field not in the downstream input schema.
 *
 * The downstream tool expects only { subject: string } but the mapper builds an
 * intermediate typed object that also has `extraField`, which triggers TS2353
 * when the object literal is directly assigned to the constrained type.
 *
 * NOTE: TypeScript's excess property check fires at the direct-assignment site, not
 * at the function-return site. Therefore the mis-wire is expressed as a typed
 * intermediate variable so tsc flags the exact line where the bad field appears.
 *
 * Expected error: TS2353 — Object literal may only specify known properties,
 *                           and 'extraField' does not exist in type '{ subject: string; }'.
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import type { Infer } from "@draht/core/define-tool";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const producer = defineTool({
  description: "Produces { summary: string }",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({ summary: z.string() }),
  execute: async ({ body }) => ({ summary: body.slice(0, 80) }),
});

const consumerSchema = z.object({ subject: z.string() });
type ConsumerInput = Infer<typeof consumerSchema>;

const consumer = defineTool({
  description: "Consumes { subject: string }",
  inputSchema: consumerSchema,
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ body: z.string() }),
  });

  const up = b.node(producer, t, (p) => ({ body: p.body }));

  const _result = b.node(consumer, up, (out) => {
    // Directly assigning to the typed shape triggers TS2353 on the extra field.
    const input: ConsumerInput = {
      subject: out.summary,
      extraField: "oops", // $ExpectError TS2353
    };
    return input;
  });

  return b.output(_result);
});
