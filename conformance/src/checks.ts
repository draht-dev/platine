// SPDX-License-Identifier: Apache-2.0
/**
 * checks.ts — the named-check registry proving T3/T5/T6 against a real
 * deployed stage (or, in --dry-run, against an in-memory simulation of one).
 *
 * Every Check is independently addressable (id-keyed) and receives a
 * CheckContext that abstracts:
 *   - storage:        the Storage seam (DynamoStorage in real mode, an
 *                      in-memory Storage implementation in --dry-run) — used
 *                      for direct row assertions (APPROVAL#/SIDEEFFECT#).
 *   - postJson / postJsonSigned: HTTP POST helpers (real: Node fetch + SigV4
 *      via @smithy/signature-v4 + @aws-sdk/credential-provider-node; dry-run:
 *      harness-provided in-memory simulation — zero network).
 *   - redeploy():     triggers a second `sst deploy` of the same stage
 *      (real mode) or a no-op (dry-run).
 *   - state:          a small mutable bag threaded across t3 → t6-hold →
 *      t6-resume-iam (runId/actionId/escalateNodeId) so those three checks
 *      can share ONE run's lifecycle, matching the harness's fixed CHECKS
 *      order. t5-survives-redeploy manages its own independent run and does
 *      NOT read or write ctx.state.
 *
 * CHECKS order (matches harness.ts sequencing): t3, t6-hold, t5-redeploy,
 * t6-resume-iam, tool-output. t5 runs BETWEEN t6-hold and t6-resume-iam so
 * the run held by t3/t6-hold also incidentally survives the same redeploy
 * that t5 exercises explicitly for its own run.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";

import type { Storage, RunId, TenantId, RunRecord } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Context / result types
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  body: unknown;
}

/** Mutable state threaded across t3 → t6-approval-hold → t6-resume-iam. */
export interface CheckState {
  runId?: RunId;
  actionId?: string;
  escalateNodeId?: string;
}

export interface CheckContext {
  /** The reference-playbook's HTTP channel Function URL (ticket submission). */
  httpUrl: string;
  /** The IAM-authenticated approval-resume Function URL. */
  resumeUrl: string;
  /** AWS region the stage is deployed to (used for SigV4 signing). */
  region: string;
  /** Storage seam — DynamoStorage (real) or an in-memory Storage (dry-run). */
  storage: Storage;
  tenantId: TenantId;
  state: CheckState;
  /** Plain (unsigned) JSON POST. */
  postJson(url: string, body: unknown): Promise<HttpResult>;
  /** SigV4-signed JSON POST (required by the IAM-authenticated resume URL). */
  postJsonSigned(url: string, body: unknown): Promise<HttpResult>;
  /** Trigger a second deploy of the same stage (real) or no-op (dry-run). */
  redeploy(): Promise<void>;
  /** Poll interval for pollRunUntil(). */
  pollIntervalMs: number;
  /** Poll timeout for pollRunUntil(). */
  pollTimeoutMs: number;
}

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  status: CheckStatus;
  /** Human-readable detail on pass, or the reason for fail/skipped. */
  detail: string;
}

export interface Check {
  id: string;
  /** When set, the check is auto-skipped unless the named capability is enabled. */
  requires?: "tool-output";
  run(ctx: CheckContext): Promise<CheckResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll storage.getRun() until `predicate` matches or pollTimeoutMs elapses. */
async function pollRunUntil(
  ctx: CheckContext,
  runId: RunId,
  predicate: (run: RunRecord) => boolean,
): Promise<RunRecord | null> {
  const deadline = Date.now() + ctx.pollTimeoutMs;
  for (;;) {
    const run = await ctx.storage.getRun(ctx.tenantId, runId);
    if (run && predicate(run)) return run;
    if (Date.now() >= deadline) return null;
    await sleep(ctx.pollIntervalMs);
  }
}

function fail(detail: string): CheckResult {
  return { status: "fail", detail };
}

function pass(detail: string): CheckResult {
  return { status: "pass", detail };
}

function newTicket(): { ticketId: string; body: string } {
  return {
    ticketId: `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    body: "I was charged twice and cannot log in.",
  };
}

// ---------------------------------------------------------------------------
// Real HTTP client — Node fetch + SigV4 (used by harness.ts in real mode)
// ---------------------------------------------------------------------------

async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Network timeout for every real HTTP call the harness makes (postJson / postJsonSigned). */
const FETCH_TIMEOUT_MS = 30_000;

/** Plain (unsigned) POST — used to prove the IAM-authenticated resume URL rejects it. */
export function createUnsignedPostJson(): (url: string, body: unknown) => Promise<HttpResult> {
  return async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { status: res.status, body: await readJsonBody(res) };
  };
}

/** SigV4-signed POST against a Lambda Function URL (service "lambda"). */
export function createSignedPostJson(region: string): (url: string, body: unknown) => Promise<HttpResult> {
  return async (url, body) => {
    const bodyStr = JSON.stringify(body);
    const u = new URL(url);

    const signer = new SignatureV4({
      credentials: defaultProvider(),
      region,
      service: "lambda",
      sha256: Sha256,
    });

    const signed = await signer.sign({
      method: "POST",
      protocol: u.protocol,
      hostname: u.hostname,
      path: u.pathname.length > 0 ? u.pathname : "/",
      headers: {
        host: u.hostname,
        "content-type": "application/json",
      },
      body: bodyStr,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: signed.headers as Record<string, string>,
      body: bodyStr,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return { status: res.status, body: await readJsonBody(res) };
  };
}

// ---------------------------------------------------------------------------
// t3-http-roundtrip
// ---------------------------------------------------------------------------

const t3HttpRoundtrip: Check = {
  id: "t3-http-roundtrip",
  async run(ctx) {
    const ticket = newTicket();
    const submit = await ctx.postJson(ctx.httpUrl, ticket);
    if (submit.status !== 202) {
      return fail(`POST ${ctx.httpUrl} expected 202, got ${submit.status}`);
    }
    const runId = (submit.body as { runId?: string } | undefined)?.runId;
    if (!runId) {
      return fail(`response body had no runId: ${JSON.stringify(submit.body)}`);
    }
    ctx.state.runId = runId as RunId;

    const run = await pollRunUntil(ctx, runId as RunId, (r) => r.status !== "queued");
    if (!run) {
      return fail(`run ${runId} did not leave "queued" status within ${ctx.pollTimeoutMs}ms`);
    }
    return pass(`runId=${runId} left queued (status=${run.status})`);
  },
};

// ---------------------------------------------------------------------------
// t6-approval-hold
// ---------------------------------------------------------------------------

const t6ApprovalHold: Check = {
  id: "t6-approval-hold",
  async run(ctx) {
    const runId = ctx.state.runId;
    if (!runId) return fail("no runId in ctx.state — t3-http-roundtrip must run first");

    const run = await pollRunUntil(ctx, runId, (r) => r.status === "awaiting_approval");
    if (!run) return fail(`run ${runId} did not reach "awaiting_approval" within ${ctx.pollTimeoutMs}ms`);

    const heldStep = run.steps.find((s) => s.heldApprovalId !== undefined);
    if (!heldStep?.heldApprovalId) {
      return fail(`run ${runId} is awaiting_approval but no step carries a heldApprovalId`);
    }
    const actionId = heldStep.heldApprovalId;

    const approval = await ctx.storage.getPendingByAction(actionId);
    if (!approval) return fail(`no APPROVAL# row found for actionId=${actionId}`);
    if (approval.runId !== runId) {
      return fail(`APPROVAL# row actionId=${actionId} belongs to a different run`);
    }

    ctx.state.actionId = actionId;
    ctx.state.escalateNodeId = String(heldStep.stepId);

    return pass(`runId=${runId} held at actionId=${actionId} (nodeId=${heldStep.stepId})`);
  },
};

// ---------------------------------------------------------------------------
// t5-survives-redeploy — fully independent run + its own redeploy + resume
// ---------------------------------------------------------------------------

const t5SurvivesRedeploy: Check = {
  id: "t5-survives-redeploy",
  async run(ctx) {
    const ticket = newTicket();
    const submit = await ctx.postJson(ctx.httpUrl, ticket);
    if (submit.status !== 202) {
      return fail(`POST ${ctx.httpUrl} expected 202, got ${submit.status}`);
    }
    const runId = (submit.body as { runId?: string } | undefined)?.runId as RunId | undefined;
    if (!runId) return fail(`response body had no runId: ${JSON.stringify(submit.body)}`);

    const held = await pollRunUntil(ctx, runId, (r) => r.status === "awaiting_approval");
    if (!held) return fail(`run ${runId} did not reach "awaiting_approval" within ${ctx.pollTimeoutMs}ms`);

    const heldStep = held.steps.find((s) => s.heldApprovalId !== undefined);
    if (!heldStep?.heldApprovalId) {
      return fail(`run ${runId} is awaiting_approval but no step carries a heldApprovalId`);
    }
    const actionId = heldStep.heldApprovalId;

    // The redeploy itself: a second `sst deploy` of the SAME stage.
    await ctx.redeploy();

    // Assert the held run + its APPROVAL# row survived the redeploy intact.
    const afterRedeploy = await ctx.storage.getRun(ctx.tenantId, runId);
    if (!afterRedeploy || afterRedeploy.status !== "awaiting_approval") {
      return fail(
        `run ${runId} did not survive redeploy in "awaiting_approval" (got status=${afterRedeploy?.status ?? "null"})`,
      );
    }
    const approvalAfterRedeploy = await ctx.storage.getPendingByAction(actionId);
    if (!approvalAfterRedeploy || approvalAfterRedeploy.status !== "pending") {
      return fail(`APPROVAL# row for actionId=${actionId} did not survive redeploy as "pending"`);
    }

    // Resume to completion.
    const resumed = await ctx.postJsonSigned(ctx.resumeUrl, {
      runId,
      actionId,
      decision: "approved",
    });
    if (resumed.status !== 200) {
      return fail(`signed resume POST expected 200, got ${resumed.status}`);
    }

    const completed = await pollRunUntil(ctx, runId, (r) => r.status === "completed");
    if (!completed) return fail(`run ${runId} did not reach "completed" within ${ctx.pollTimeoutMs}ms`);

    return pass(`runId=${runId} held → survived redeploy → resumed → completed`);
  },
};

// ---------------------------------------------------------------------------
// t6-resume-iam — unsigned 403, signed 200, completes, SIDEEFFECT# ledger
// ---------------------------------------------------------------------------

const t6ResumeIam: Check = {
  id: "t6-resume-iam",
  async run(ctx) {
    const runId = ctx.state.runId;
    const actionId = ctx.state.actionId;
    if (!runId || !actionId) {
      return fail("no runId/actionId in ctx.state — t3-http-roundtrip + t6-approval-hold must run first");
    }

    const unsigned = await ctx.postJson(ctx.resumeUrl, { runId, actionId, decision: "approved" });
    if (unsigned.status !== 403) {
      return fail(`unsigned POST to resumeUrl expected 403, got ${unsigned.status}`);
    }

    const signed = await ctx.postJsonSigned(ctx.resumeUrl, { runId, actionId, decision: "approved" });
    if (signed.status !== 200) {
      return fail(`signed POST to resumeUrl expected 200, got ${signed.status}`);
    }

    const completed = await pollRunUntil(ctx, runId, (r) => r.status === "completed");
    if (!completed) return fail(`run ${runId} did not reach "completed" within ${ctx.pollTimeoutMs}ms`);

    if (!ctx.state.escalateNodeId) {
      return fail(
        "no escalateNodeId in ctx.state — t6-approval-hold must run first to capture it; " +
          "cannot verify the SIDEEFFECT# ledger",
      );
    }
    const ledger = await ctx.storage.hasSideEffect(ctx.tenantId, runId, ctx.state.escalateNodeId);
    if (!ledger) {
      return fail(`no SIDEEFFECT# row for nodeId=${ctx.state.escalateNodeId} after completion`);
    }

    return pass(
      `runId=${runId} unsigned=403, signed=200, completed, SIDEEFFECT# row present (nodeId=${ctx.state.escalateNodeId})`,
    );
  },
};

// ---------------------------------------------------------------------------
// tool-output — asserts the classify node's real (non-stub) tool output,
// gated behind DRAHT_ASSERT_TOOL_OUTPUT=1 + Bedrock model access.
// ---------------------------------------------------------------------------

/** True iff `value` is a plain object with at least one own key (not `{}`, not an array). */
function isNonEmptyObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

const toolOutput: Check = {
  id: "tool-output",
  requires: "tool-output",
  async run(ctx) {
    if (process.env["DRAHT_ASSERT_TOOL_OUTPUT"] !== "1") {
      return {
        status: "skipped",
        detail:
          "assertion exists but requires DRAHT_ASSERT_TOOL_OUTPUT=1 + Bedrock model access " +
          "in the CI account (see README)",
      };
    }

    // Reuse the t3/t6 run's shared ctx.state — do NOT submit a new ticket.
    const runId = ctx.state.runId;
    if (!runId) {
      return fail("no runId in ctx.state — t3-http-roundtrip must run first");
    }

    const run = await ctx.storage.getRun(ctx.tenantId, runId);
    if (!run) return fail(`run ${runId} not found in storage`);

    // The classify node is whichever completed step is NOT the escalate node
    // captured by t6-approval-hold (works whether nodeIds are the fakes'
    // literal "classify"/"escalate" or a real deploy's manifest-generated ids).
    const classifyStep = run.steps.find(
      (s) => s.status === "completed" && String(s.stepId) !== ctx.state.escalateNodeId,
    );
    if (!classifyStep) {
      return fail(
        `no completed classify step found for run ${runId} ` +
          `(excluding escalateNodeId=${ctx.state.escalateNodeId ?? "<unset>"})`,
      );
    }
    const classifyNodeId = String(classifyStep.stepId);

    const ledger = await ctx.storage.hasSideEffect(ctx.tenantId, runId, classifyNodeId);
    if (!ledger) {
      return fail(`no SIDEEFFECT# row for classify nodeId=${classifyNodeId}`);
    }

    if (!isNonEmptyObject(ledger.result)) {
      return fail(
        `classify nodeId=${classifyNodeId} SIDEEFFECT# stored output is empty/stub: ${JSON.stringify(ledger.result)}`,
      );
    }

    return pass(
      `classify nodeId=${classifyNodeId} SIDEEFFECT# output is a non-empty object: ${JSON.stringify(ledger.result)}`,
    );
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Ordered check list. This exact order matters:
 *   t3 (submit)  → t6-hold (capture actionId) → t5 (independent run,
 *   proves redeploy survival) → t6-resume-iam (resumes the t3/t6-hold run,
 *   which has ALSO now survived the t5 redeploy) → tool-output (skipped).
 */
export const CHECKS: readonly Check[] = [
  t3HttpRoundtrip,
  t6ApprovalHold,
  t5SurvivesRedeploy,
  t6ResumeIam,
  toolOutput,
];
