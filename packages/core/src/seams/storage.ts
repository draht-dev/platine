// SPDX-License-Identifier: Apache-2.0
// Storage seam — single durability surface. FORCES Engine-3 flush+drain.

import type { TenantId, RunId } from "./ids.js";
import type {
  RunRecord,
  RunStatus,
  StepCheckpoint,
  SideEffectRow,
  ApprovalRow,
  Usage,
} from "./types.js";

export interface Storage {
  /** patch-not-create: if run already exists returns it unchanged */
  ensureRun(r: {
    tenantId: TenantId;
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
  }): Promise<RunRecord>;

  getRun(t: TenantId, runId: RunId): Promise<RunRecord | null>;

  /** rehydrate the Map, never a single previousOutput */
  loadStepOutputs(t: TenantId, runId: RunId): Promise<Map<string, unknown>>;

  /**
   * Engine-3: the ONLY checkpoint method serializes onto an internal per-run chain.
   */
  appendCheckpoint(c: StepCheckpoint): Promise<void>;

  /**
   * co-writes STEP#completed + SIDEEFFECT# in ONE transactWrite (ElectroDB 3.7.5)
   */
  commitStepWithSideEffect(step: StepCheckpoint, ledger: SideEffectRow): Promise<void>;

  /** mandatory PRE-CHECK before any tool dispatch */
  hasSideEffect(t: TenantId, runId: RunId, nodeId: string): Promise<SideEffectRow | null>;

  /** awaits the full chain BEFORE any terminal status write */
  setRunStatus(
    t: TenantId,
    runId: RunId,
    status: RunStatus,
    fin: { usage?: Usage; costUsd?: number; error?: string },
  ): Promise<void>;

  /** manifest is persisted PER-REVISION, never overwritten */
  putManifest(manifestId: string, revision: string, blob: string): Promise<void>;

  /** resume loads THIS revision */
  loadManifest(manifestId: string, revision: string): Promise<string>;

  /** idempotent on (runId, stepId) */
  createPendingApproval(a: ApprovalRow): Promise<void>;

  resolveApproval(actionId: string, verdict: "approved" | "rejected"): Promise<void>;

  getPendingByAction(actionId: string): Promise<ApprovalRow | null>;
}
