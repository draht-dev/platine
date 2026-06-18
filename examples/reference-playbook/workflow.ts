// SPDX-License-Identifier: Apache-2.0
/**
 * workflow.ts — reference-playbook support-triage workflow.
 *
 * Graph:
 *
 *   trigger (event: ticket.created, filters: priority=high)
 *     └─ classify   (local tool, no approval)
 *         └─ escalate (local tool, needsApproval: true — approval-gated)
 *
 * `platine build` compiles this file to .platine/manifest.json.
 * The manifest is what `draht.Agent()` in sst.config.ts reads at deploy time.
 */

import { z } from "zod/v4";
import { defineWorkflow } from "@draht/core/define-workflow";
import type { WorkflowCompileOptions } from "@draht/core/define-workflow";
import { classify } from "./tools/classify.js";
import { escalateTicket } from "./tools/escalate.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load the agent instructions from agent.md.
 * Falls back to a short inline string if the file cannot be read (e.g. in unit tests).
 */
function loadInstructions(): string {
  try {
    return readFileSync(resolve(__dirname, "agent.md"), "utf8");
  } catch {
    return "You triage support tickets.";
  }
}

// ── Build the workflow DAG ────────────────────────────────────────────────────

const _wf = defineWorkflow((b) => {
  // ── Trigger ───────────────────────────────────────────────────────────────
  // Fires when a ticket.created event is published on the EventBridge bus.
  // The payload carries ticketId + body.
  const trigger = b.trigger({
    type: "event",
    eventType: "ticket.created",
    filters: [{ field: "priority", operator: "eq", value: "high" }],
    payload: z.object({
      ticketId: z.string(),
      body: z.string(),
    }),
  });

  // ── Step 1: classify ──────────────────────────────────────────────────────
  // Map the trigger payload to the classify tool's input.
  // p: { ticketId: string; body: string } — inferred from trigger payload.
  const classified = b.node(
    classify,
    trigger,
    (p) => ({ ticketId: p.ticketId, body: p.body }),
    // No approval needed for classification.
  );

  // ── Step 2: escalate (approval-gated) ───────────────────────────────────
  // Map classify output to escalate input.
  // out: { ticketId; category; severity; summary } — inferred from classify outputSchema.
  // The escalateTicket tool has needsApproval: true, which propagates to the
  // manifest node and causes the runtime to hold execution pending human approval.
  const escalated = b.node(
    escalateTicket,
    classified,
    (out) => ({
      ticketId: out.ticketId,
      // Build a canonical reason from the ticket category.
      reason:
        out.category === "billing"
          ? "billing-issue-requires-human-review"
          : out.category === "technical"
            ? "critical-technical-issue"
            : out.category === "account"
              ? "account-security-or-access-issue"
              : "high-priority-requires-human-review",
      summary: out.summary,
    }),
    // Explicitly mark as requiring approval — the runtime will hold execution
    // at this node until a human reviewer approves via the resume API.
    { requiresApproval: true },
  );

  // ── Terminal node ────────────────────────────────────────────────────────
  return b.output(escalated);
});

// ── Augment compile() with proper agentId / model / instructions ─────────────
//
// The CLI calls workflowDef.compile() with no args; defaults produce
// agentId="workflow" and provider="anthropic". We override compile() here
// to bake in the correct options so the manifest is correct from first build.
//
// This does NOT change the WorkflowDef structure — only the compile() wrapper.

const COMPILE_OPTS: WorkflowCompileOptions = {
  agentId: "support-triage",
  name: "Support Triage",
  model: {
    provider: "bedrock",
    modelId: "eu.anthropic.claude-haiku-4-5",
  },
  instructions: loadInstructions(),
};

export default {
  ..._wf,
  compile: (opts?: WorkflowCompileOptions) => _wf.compile({ ...COMPILE_OPTS, ...opts }),
};
