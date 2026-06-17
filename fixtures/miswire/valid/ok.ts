// SPDX-License-Identifier: Apache-2.0
/**
 * valid/ok.ts — a correctly-wired workflow.
 *
 * This MUST compile with ZERO TypeScript errors.
 * If tsc reports any errors here, the DSL builder has regressed.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const classify = defineTool({
  description: "Classify a support ticket",
  inputSchema: z.object({ body: z.string() }),
  outputSchema: z.object({
    summary: z.string(),
    severity: z.enum(["low", "med", "high"]),
  }),
  execute: async ({ body }) => ({
    summary: body.slice(0, 80),
    severity: "high" as const,
  }),
});

const createTicket = defineTool({
  description: "Create a ticket",
  inputSchema: z.object({
    subject: z.string(),
    priority: z.enum(["low", "med", "high"]),
  }),
  outputSchema: z.object({ ticketId: z.string() }),
  execute: async ({ subject, priority }) => ({ ticketId: `t_${subject}_${priority}` }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "event",
    eventType: "ticket.created",
    payload: z.object({ body: z.string() }),
  });

  const c = b.node(classify, t, (p) => ({ body: p.body }));

  const t2 = b.node(createTicket, c, (out) => ({
    subject: out.summary,
    priority: out.severity,
  }));

  return b.output(t2);
});
