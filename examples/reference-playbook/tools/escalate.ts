// SPDX-License-Identifier: Apache-2.0
/**
 * escalate_ticket tool — push a high-severity ticket to the human support
 * queue.  This tool is APPROVAL-GATED: a human reviewer must approve the
 * escalation before it executes.
 *
 * In a real deployment the execute body would call an external API (e.g. a
 * ticketing system or a Slack webhook).  Here we return a typed stub so the
 * reference playbook compiles and runs in CI without real credentials.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";

export const escalateTicket = defineTool({
  description:
    "Escalate a high-severity support ticket to the human review queue. " +
    "Requires human approval before execution.",

  inputSchema: z.object({
    ticketId: z.string().describe("The ticket to escalate."),
    reason: z
      .string()
      .describe(
        "Canonical escalation reason (see escalation-policy skill)."
      ),
    summary: z.string().max(120).describe("Short description of the issue."),
  }),

  outputSchema: z.object({
    queued: z.boolean(),
    queuedAt: z.string(),
    escalationId: z.string(),
  }),

  /** Approval-gate: always requires human sign-off before execution. */
  needsApproval: true,

  execute: async ({ ticketId, reason, summary }, { idempotencyKey }) => {
    // Stub: in production this calls your ticketing API.
    // The idempotencyKey can be forwarded as the provider idempotency key.
    void reason;
    void summary;
    void idempotencyKey;
    return {
      queued: true,
      queuedAt: new Date().toISOString(),
      escalationId: `esc_${ticketId}_${Date.now()}`,
    };
  },
});
