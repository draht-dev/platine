// SPDX-License-Identifier: Apache-2.0
/**
 * classify tool — analyse a raw ticket body and return a structured
 * classification.  No external I/O; pure text transformation.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";

export const classify = defineTool({
  description:
    "Classify a support ticket: extract category, severity, and a short summary.",

  inputSchema: z.object({
    ticketId: z.string().describe("Opaque ticket identifier from the event."),
    body: z.string().describe("Raw text of the support ticket."),
  }),

  outputSchema: z.object({
    ticketId: z.string(),
    category: z.enum(["billing", "technical", "account", "other"]),
    severity: z.enum(["low", "medium", "high"]),
    summary: z.string().max(120),
  }),

  execute: async ({ ticketId, body }) => {
    // Naive heuristic for the reference playbook — in production the agent
    // model loop (via defineAgent) would produce this.
    const lower = body.toLowerCase();
    const category = lower.includes("charge") || lower.includes("invoice") || lower.includes("billing")
      ? "billing" as const
      : lower.includes("login") || lower.includes("password") || lower.includes("account")
        ? "account" as const
        : lower.includes("error") || lower.includes("crash") || lower.includes("bug")
          ? "technical" as const
          : "other" as const;

    const severity = lower.includes("urgent") || lower.includes("critical") || lower.includes("twice") || lower.includes("cannot")
      ? "high" as const
      : lower.includes("slow") || lower.includes("annoying")
        ? "medium" as const
        : "low" as const;

    const summary = body.slice(0, 120).replace(/\s+/g, " ").trim();
    return { ticketId, category, severity, summary };
  },
});
