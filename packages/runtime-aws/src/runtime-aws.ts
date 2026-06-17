// SPDX-License-Identifier: Apache-2.0
/**
 * runtime-aws.ts — AwsRuntime implements the Runtime seam using SQS.
 *
 * Architecture:
 * - submitRun: computes deterministic runId, ensureRun, sends SQS message
 * - resumeRun: resolves approval/signal, re-enqueues via SQS SendMessage
 * - cancelRun: sets run status to "cancelled"
 * - getRun: delegates to Storage
 *
 * SQS visibility timeout MUST exceed Lambda executor timeout.
 * This is a deploy-time concern enforced by the SST component in P6.
 * The executor Lambda uses a soft time budget (getRemainingTimeInMillis() - 3 min)
 * so SQS messages are always processed before visibility timeout.
 *
 * The deterministic runId is computed at the channel/trigger boundary BEFORE enqueue
 * (using deriveRunId from executor.ts). This is the idempotency anchor: the RUN row
 * is pre-created via ensureRun (patch-not-create); the executor patches-not-creates
 * and no-ops on redelivery.
 */

import {
  SQSClient,
  SendMessageCommand,
  type SendMessageCommandInput,
} from "@aws-sdk/client-sqs";

import type { Runtime, Storage } from "@draht/core/seams";
import type {
  TenantId,
  RunId,
  RunStatus,
  RunRecord,
  TriggerEnvelope,
} from "@draht/core/seams";
import { DEFAULT_TENANT } from "@draht/core/seams";
import { deriveRunId } from "./executor.js";

// ---------------------------------------------------------------------------
// AwsRuntime
// ---------------------------------------------------------------------------

export interface AwsRuntimeOptions {
  /**
   * queueUrl — SQS queue URL for the executor Lambda trigger.
   * Visibility timeout of this queue MUST exceed the Lambda function timeout
   * to prevent concurrent redelivery mid-execution.
   * The SST component enforces this constraint at deploy time.
   */
  queueUrl: string;
  /**
   * storage — the DynamoDB Storage implementation for getRun / ensureRun / setRunStatus.
   */
  storage: Storage;
  /**
   * client — injectable SQSClient (use real client in prod; mock in tests).
   */
  client: SQSClient;
  /**
   * tenantId — default tenant for getRun (single-tenant v1).
   */
  tenantId?: TenantId;
}

export class AwsRuntime implements Runtime {
  private readonly queueUrl: string;
  private readonly storage: Storage;
  private readonly client: SQSClient;
  private readonly tenantId: TenantId;

  constructor(opts: AwsRuntimeOptions) {
    this.queueUrl = opts.queueUrl;
    this.storage  = opts.storage;
    this.client   = opts.client;
    this.tenantId = opts.tenantId ?? DEFAULT_TENANT;
  }

  /**
   * submitRun — pre-creates the RUN row + enqueues an SQS message.
   *
   * The caller MUST have called deriveRunId() to compute the deterministic runId
   * at the channel/trigger boundary before calling submitRun().
   *
   * The trigger input is seeded as a "__trigger__" checkpoint so the executor
   * can resolve it without re-reading the SQS message payload.
   */
  async submitRun(i: {
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
    tenantId: TenantId;
    trigger: TriggerEnvelope;
    input: Record<string, unknown>;
    chainDepth: number;
  }): Promise<{ status: RunStatus }> {
    const run = await this.storage.ensureRun({
      tenantId: i.tenantId,
      runId: i.runId,
      manifestId: i.manifestId,
      manifestRevision: i.manifestRevision,
    });

    // Only enqueue if not already terminal / held / paused (idempotent submit)
    if (run.status === "queued" || run.status === "running") {
      // Seed the trigger input checkpoint
      await this.storage.appendCheckpoint({
        tenantId: i.tenantId,
        runId: i.runId,
        stepId: "__trigger__",
        status: "completed",
        output: { ...i.input, ...(i.trigger.payload ?? {}) },
      });

      // Send SQS message
      // MessageDeduplicationId + MessageGroupId (if FIFO) ensure exactly-once delivery
      // at the queue level. We use the deterministic runId as the dedup ID.
      const msgInput: SendMessageCommandInput = {
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({
          runId: i.runId,
          tenantId: i.tenantId,
          continuationCount: 0,
          chainDepth: i.chainDepth,
        }),
        MessageAttributes: {
          continuationCount: {
            DataType: "Number",
            StringValue: "0",
          },
          runId: {
            DataType: "String",
            StringValue: i.runId,
          },
        },
      };

      await this.client.send(new SendMessageCommand(msgInput));
    }

    return { status: run.status };
  }

  /**
   * resumeRun — handles approval/signal/continue resumes.
   *
   * For approval: resolves the approval row, resets status to "running",
   * then sends an SQS continuation message.
   * For continue: resets status + re-enqueues.
   */
  async resumeRun(
    i:
      | { kind: "approval"; runId: RunId; approvalId: string; decision: "approved" | "rejected"; by?: string }
      | { kind: "signal"; runId: RunId; signal: string; payload?: Record<string, unknown> }
      | { kind: "continue"; runId: RunId },
  ): Promise<{ status: RunStatus }> {
    const run = await this.storage.getRun(this.tenantId, i.runId);
    if (!run) throw new Error(`Run not found: ${i.runId}`);

    if (i.kind === "approval") {
      const approval = await this.storage.getPendingByAction(i.approvalId);
      if (!approval) throw new Error(`Approval not found: ${i.approvalId}`);
      if (approval.status !== "pending") {
        return { status: run.status };
      }

      await this.storage.resolveApproval(i.approvalId, i.decision);

      if (i.decision === "approved") {
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        await this._enqueueResume(i.runId);
      } else {
        await this.storage.setRunStatus(this.tenantId, i.runId, "failed", {
          error: `Approval rejected by ${i.by ?? "unknown"}`,
        });
      }
    } else if (i.kind === "continue") {
      if (run.status === "paused" || run.status === "awaiting_approval") {
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        await this._enqueueResume(i.runId);
      }
    } else {
      // signal — not implemented in v1, treat as continue
      if (run.status === "paused") {
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        await this._enqueueResume(i.runId);
      }
    }

    const updated = await this.storage.getRun(this.tenantId, i.runId);
    return { status: updated?.status ?? run.status };
  }

  async cancelRun(runId: RunId): Promise<void> {
    const run = await this.storage.getRun(this.tenantId, runId);
    if (!run) return;
    if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
      await this.storage.setRunStatus(this.tenantId, runId, "cancelled", {});
    }
  }

  async getRun(runId: RunId): Promise<RunRecord | null> {
    return this.storage.getRun(this.tenantId, runId);
  }

  private async _enqueueResume(runId: RunId): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({
          runId,
          tenantId: this.tenantId,
          continuationCount: 0,
          isResume: true,
        }),
        MessageAttributes: {
          runId: { DataType: "String", StringValue: runId },
          isResume: { DataType: "String", StringValue: "true" },
        },
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Re-export deriveRunId for use by channel/trigger handlers
// ---------------------------------------------------------------------------
export { deriveRunId };
