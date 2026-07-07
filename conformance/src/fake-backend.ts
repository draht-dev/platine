// SPDX-License-Identifier: Apache-2.0
/**
 * fake-backend.ts — shared in-memory fake of the ingress/resume Lambda
 * handlers, wired directly to a MemoryStorage instance.
 *
 * Used by BOTH harness.ts's --dry-run mode and checks.test.ts's offline unit
 * tests, so the two environments simulate identical behaviour instead of
 * drifting apart (this used to be ~75 lines duplicated verbatim in each).
 *
 * Submitting a ticket walks the run straight to "awaiting_approval" (the
 * model/executor loop itself is irrelevant to what CHECKS assert); a signed
 * resume walks it to "completed" with a SIDEEFFECT# row for the escalate
 * node. Unsigned resume POSTs are always rejected with 403, matching the
 * real IAM-authenticated Function URL.
 */

import { randomUUID } from "node:crypto";
import type { MemoryStorage } from "@draht/runtime-aws";
import type { RunId, TenantId } from "@draht/core/seams";
import type { HttpResult } from "./checks.js";

/** stepId/nodeId used for the escalate node in every fake-backend run. */
export const FAKE_BACKEND_ESCALATE_NODE_ID = "escalate";
/** stepId used for the classify node in every fake-backend run. */
export const FAKE_BACKEND_CLASSIFY_NODE_ID = "classify";

export interface FakeBackendUrls {
  httpUrl: string;
  resumeUrl: string;
}

export interface FakeBackend {
  postJson(url: string, body: unknown): Promise<HttpResult>;
  postJsonSigned(url: string, body: unknown): Promise<HttpResult>;
}

/**
 * @param manifestRevision distinguishes callers in storage records only
 *   (e.g. "rev_dry_run" vs "rev_test") — never asserted on by CHECKS.
 */
export function makeFakeBackend(
  storage: MemoryStorage,
  tenantId: TenantId,
  urls: FakeBackendUrls,
  manifestRevision = "rev_fake",
): FakeBackend {
  async function postJson(url: string, _body: unknown): Promise<HttpResult> {
    if (url === urls.httpUrl) {
      const runId = `run_${randomUUID()}` as RunId;
      await storage.ensureRun({
        tenantId,
        runId,
        manifestId: "support-triage",
        manifestRevision,
      });
      await storage.appendCheckpoint({
        tenantId,
        runId,
        stepId: FAKE_BACKEND_CLASSIFY_NODE_ID,
        status: "completed",
        output: { category: "billing" },
      });
      const actionId = `action_${randomUUID()}`;
      await storage.createPendingApproval({
        runId,
        stepId: FAKE_BACKEND_ESCALATE_NODE_ID,
        actionId,
        nodeId: FAKE_BACKEND_ESCALATE_NODE_ID,
        toolName: "escalate_ticket",
        paramsJson: "{}",
        status: "pending",
        idempotencyKey: `${runId}:${FAKE_BACKEND_ESCALATE_NODE_ID}`,
      });
      await storage.appendCheckpoint({
        tenantId,
        runId,
        stepId: FAKE_BACKEND_ESCALATE_NODE_ID,
        status: "awaiting_approval",
        heldApprovalId: actionId,
      });
      await storage.setRunStatus(tenantId, runId, "awaiting_approval", {});
      return { status: 202, body: { runId, status: "queued" } };
    }
    if (url === urls.resumeUrl) {
      // Unsigned resume — the IAM-authenticated Function URL always rejects this.
      return { status: 403, body: { message: "Forbidden (unsigned always rejected)" } };
    }
    throw new Error(`fake backend: unhandled postJson url ${url}`);
  }

  async function postJsonSigned(url: string, body: unknown): Promise<HttpResult> {
    if (url !== urls.resumeUrl) {
      throw new Error(`fake backend: unhandled postJsonSigned url ${url}`);
    }
    const { runId, actionId } = body as { runId: RunId; actionId: string; decision: string };
    const approval = await storage.getPendingByAction(actionId);
    if (!approval || approval.runId !== runId) return { status: 404, body: { error: "not found" } };
    await storage.resolveApproval(actionId, "approved");
    await storage.commitStepWithSideEffect(
      {
        tenantId,
        runId,
        stepId: FAKE_BACKEND_ESCALATE_NODE_ID,
        status: "completed",
        output: { queued: true },
      },
      {
        tenantId,
        runId,
        nodeId: FAKE_BACKEND_ESCALATE_NODE_ID,
        idempotencyKey: `${runId}:${FAKE_BACKEND_ESCALATE_NODE_ID}`,
        toolName: "escalate_ticket",
        result: { queued: true },
      },
    );
    await storage.setRunStatus(tenantId, runId, "completed", {});
    return { status: 200, body: { runId, status: "completed" } };
  }

  return { postJson, postJsonSigned };
}
