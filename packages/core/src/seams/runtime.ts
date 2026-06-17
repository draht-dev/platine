// SPDX-License-Identifier: Apache-2.0
// Runtime seam — the swap seam.
// MINIMAL: no scheduling/level/fanout/continuation leaks.
// v2 Temporal/Restate swaps ONLY Runtime; reuses Model/Storage/Channel/EventBus/Tenancy unchanged.

import type { TenantId, RunId } from "./ids.js";
import type { RunRecord, RunStatus, TriggerEnvelope } from "./types.js";

export interface Runtime {
  submitRun(i: {
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
    tenantId: TenantId;
    trigger: TriggerEnvelope;
    input: Record<string, unknown>;
    chainDepth: number;
  }): Promise<{ status: RunStatus }>;

  resumeRun(
    i:
      | { kind: "approval"; runId: RunId; approvalId: string; decision: "approved" | "rejected"; by?: string }
      | { kind: "signal"; runId: RunId; signal: string; payload?: Record<string, unknown> }
      | { kind: "continue"; runId: RunId },
  ): Promise<{ status: RunStatus }>;

  cancelRun(runId: RunId): Promise<void>;

  getRun(runId: RunId): Promise<RunRecord | null>;
}
