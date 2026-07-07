// SPDX-License-Identifier: Apache-2.0
/**
 * runtime-local.ts — In-memory seam implementations for `platine dev` and tests.
 *
 * Provides:
 * - MemoryStorage: implements Storage; emulates transactWrite atomicity of
 *   commitStepWithSideEffect; per-run checkpoint chain; snapshots PINNED manifest
 *   per run so hot-reload cannot corrupt in-flight runs.
 * - MemoryQueue: drives the executor in-process; `redeliver` toggle re-delivers
 *   a processed message to simulate at-least-once.
 * - MemoryBus: EventBus + subscribe, with MAX_CHAIN_DEPTH guard.
 * - LocalRuntime: implements the Runtime seam. submitRun derives runId at the boundary,
 *   ensureRun pre-creates, enqueues. resumeRun handles approval/signal/continue.
 *   SAME executor.ts behind the seams.
 */

import { randomUUID } from "node:crypto";
import type {
  TenantId,
  RunId,
  RunStatus,
  RunRecord,
  StepCheckpoint,
  SideEffectRow,
  ApprovalRow,
  Usage,
  DrahtEvent,
  EventFilter,
  TriggerEnvelope,
} from "@draht/core/seams";
import { MAX_CHAIN_DEPTH, matchesFilter, DEFAULT_TENANT } from "@draht/core/seams";
import type { Storage } from "@draht/core/seams";
import type { EventBus } from "@draht/core/seams";
import type { Runtime } from "@draht/core/seams";
import type { Tenancy } from "@draht/core/seams";
import type { Model } from "@draht/core/seams";
import {
  drive,
  deriveRunId,
  type ExecutorContext,
  type ExecutorDeps,
  type Queue,
  type ToolsDispatcher,
  type ApprovalsCoordinator,
} from "./executor.js";

// ---------------------------------------------------------------------------
// MemoryStorage
// ---------------------------------------------------------------------------

/** In-memory run state. */
interface MemRun {
  record: RunRecord;
  /** Serialized per-run checkpoint chain (Engine-3 simulation). */
  flushChain: Promise<void>;
}

export class MemoryStorage implements Storage {
  /** runId → MemRun */
  private readonly runs = new Map<string, MemRun>();
  /** runId → nodeId → SideEffectRow */
  private readonly sideEffects = new Map<string, Map<string, SideEffectRow>>();
  /** actionId → ApprovalRow */
  private readonly approvals = new Map<string, ApprovalRow>();
  /** manifestId#revision → blob */
  private readonly manifests = new Map<string, string>();

  async ensureRun(r: {
    tenantId: TenantId;
    runId: RunId;
    manifestId: string;
    manifestRevision: string;
  }): Promise<RunRecord> {
    const existing = this.runs.get(r.runId);
    if (existing) return existing.record;

    const record: RunRecord = {
      tenantId: r.tenantId,
      runId: r.runId,
      manifestId: r.manifestId,
      manifestRevision: r.manifestRevision,
      status: "queued",
      chainDepth: 0,
      attempt: 1,
      continuations: 0,
      steps: [],
    };
    this.runs.set(r.runId, { record, flushChain: Promise.resolve() });
    return record;
  }

  async getRun(t: TenantId, runId: RunId): Promise<RunRecord | null> {
    void t;
    return this.runs.get(runId)?.record ?? null;
  }

  async loadStepOutputs(t: TenantId, runId: RunId): Promise<Map<string, unknown>> {
    void t;
    const run = this.runs.get(runId);
    if (!run) return new Map();
    const map = new Map<string, unknown>();
    for (const s of run.record.steps) {
      if (s.status === "completed" || s.status === "skipped") {
        if (s.output !== undefined) {
          map.set(String(s.stepId), s.output);
        }
      }
    }
    return map;
  }

  /**
   * appendCheckpoint — Engine-3: serializes onto the internal per-run chain.
   * This ensures checkpoints for a run are always written in order.
   */
  async appendCheckpoint(c: StepCheckpoint): Promise<void> {
    const run = this.runs.get(c.runId);
    if (!run) return;

    // Serialize onto the per-run chain
    run.flushChain = run.flushChain.then(() => {
      this._applyCheckpoint(c);
    });
    await run.flushChain;
  }

  private _applyCheckpoint(c: StepCheckpoint): void {
    const run = this.runs.get(c.runId);
    if (!run) return;
    const existing = run.record.steps.findIndex((s) => s.stepId === c.stepId);
    if (existing >= 0) {
      run.record.steps[existing] = c;
    } else {
      run.record.steps.push(c);
    }
  }

  /**
   * commitStepWithSideEffect — atomic co-write of STEP#completed + SIDEEFFECT#.
   * In memory: both writes happen synchronously within the per-run chain.
   */
  async commitStepWithSideEffect(step: StepCheckpoint, ledger: SideEffectRow): Promise<void> {
    const run = this.runs.get(step.runId);
    if (!run) return;

    // Serialize onto the per-run chain (Engine-3)
    run.flushChain = run.flushChain.then(() => {
      this._applyCheckpoint(step);
      // Write side-effect ledger row
      let runEffects = this.sideEffects.get(step.runId);
      if (!runEffects) {
        runEffects = new Map();
        this.sideEffects.set(step.runId, runEffects);
      }
      // Idempotent: only write if not present (simulates DynamoDB conditional put)
      if (!runEffects.has(ledger.nodeId)) {
        runEffects.set(ledger.nodeId, ledger);
      }
    });
    await run.flushChain;
  }

  async hasSideEffect(t: TenantId, runId: RunId, nodeId: string): Promise<SideEffectRow | null> {
    void t;
    return this.sideEffects.get(runId)?.get(nodeId) ?? null;
  }

  /**
   * setRunStatus — awaits the full per-run chain BEFORE writing the terminal status.
   */
  async setRunStatus(
    t: TenantId,
    runId: RunId,
    status: RunStatus,
    fin: { usage?: Usage; costUsd?: number; error?: string },
  ): Promise<void> {
    void t;
    const run = this.runs.get(runId);
    if (!run) return;

    // DRAIN: await the full checkpoint chain before terminal write
    await run.flushChain;

    run.record.status = status;
    if (fin.usage !== undefined) run.record.usage = fin.usage;
    if (fin.costUsd !== undefined) run.record.costUsd = fin.costUsd;
    if (fin.error !== undefined) run.record.error = fin.error;
  }

  async putManifest(manifestId: string, revision: string, blob: string): Promise<void> {
    const key = `${manifestId}#${revision}`;
    // Never overwritten — idempotent
    if (!this.manifests.has(key)) {
      this.manifests.set(key, blob);
    }
  }

  async loadManifest(manifestId: string, revision: string): Promise<string> {
    const key = `${manifestId}#${revision}`;
    const blob = this.manifests.get(key);
    if (!blob) throw new Error(`Manifest not found: ${manifestId}@${revision}`);
    return blob;
  }

  async createPendingApproval(a: ApprovalRow): Promise<void> {
    // Idempotent on (runId, stepId) — first writer wins, later duplicate
    // calls are dropped. MAJOR 2 fix: callers (FakeApprovalsCoordinator.hold)
    // MUST check getApprovalByStep for an existing row BEFORE minting a new
    // actionId, so this no-op path never leaves a caller holding a
    // never-stored ("dangling") actionId.
    const existingKey = [...this.approvals.values()].find(
      (r) => r.runId === a.runId && r.stepId === a.stepId,
    );
    if (existingKey) return;
    this.approvals.set(a.actionId, { ...a, createdAt: a.createdAt ?? new Date().toISOString() });
  }

  async resolveApproval(actionId: string, verdict: "approved" | "rejected"): Promise<void> {
    const row = this.approvals.get(actionId);
    if (!row) throw new Error(`Approval not found: ${actionId}`);
    // HOLE E FIX: idempotent — if already resolved (status !== 'pending'), first verdict wins.
    // A late re-resolve (e.g., approve-then-reject) must NOT flip the status.
    if (row.status !== "pending") return;
    this.approvals.set(actionId, { ...row, status: verdict });
  }

  async getPendingByAction(actionId: string): Promise<ApprovalRow | null> {
    return this.approvals.get(actionId) ?? null;
  }

  async getApprovalByStep(_t: TenantId, runId: RunId, nodeId: string): Promise<ApprovalRow | null> {
    // MAJOR 2 fix: deterministically prefer a resolved row (approved/rejected)
    // over a pending one, tiebreak by newest createdAt — mirrors
    // DynamoStorage.getApprovalByStep so both Storage implementations agree
    // (a later approved row is never shadowed by an earlier-or-later pending
    // duplicate).
    const rank = (s: ApprovalRow["status"]): number => (s === "pending" ? 0 : 1);
    let best: ApprovalRow | null = null;
    for (const row of this.approvals.values()) {
      if (row.runId !== runId || row.nodeId !== nodeId) continue;
      if (best === null) {
        best = row;
        continue;
      }
      const rowRank = rank(row.status);
      const bestRank = rank(best.status);
      if (rowRank !== bestRank) {
        if (rowRank > bestRank) best = row;
      } else if ((row.createdAt ?? "") >= (best.createdAt ?? "")) {
        best = row;
      }
    }
    return best;
  }

  // Expose internals for testing
  getApprovals(): Map<string, ApprovalRow> {
    return this.approvals;
  }
}

// ---------------------------------------------------------------------------
// MemoryQueue
// ---------------------------------------------------------------------------

/** A pending queue entry. */
interface QueueEntry {
  runId: RunId;
  continuationCount: number;
  /** If true, this is a dead-letter entry (failed/DLQ). */
  isDlq: boolean;
}

export class MemoryQueue implements Queue {
  private readonly pending: QueueEntry[] = [];
  /**
   * redeliver toggle: if true, a processed message is re-delivered once to
   * simulate at-least-once delivery semantics.
   */
  public redeliver = false;
  private readonly processedOnce = new Set<string>();
  private readonly dlq: QueueEntry[] = [];

  enqueue(runId: RunId, continuationCount = 0): void {
    this.pending.push({ runId, continuationCount, isDlq: false });
  }

  async enqueueContinuation(runId: RunId, continuationCount: number): Promise<void> {
    this.pending.push({ runId, continuationCount, isDlq: false });
  }

  async enqueueDeadLetter(runId: RunId, reason: string): Promise<void> {
    void reason;
    this.dlq.push({ runId, continuationCount: 0, isDlq: true });
  }

  get dlqEntries(): QueueEntry[] {
    return this.dlq;
  }

  /**
   * drain() — process all pending messages using the provided executor deps.
   * Runs until the queue is empty.
   */
  async drain(
    deps: ExecutorDeps,
    opts: {
      tenantId?: TenantId;
      deadlineAt?: number;
      maxContinuations?: number;
    } = {},
  ): Promise<void> {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const maxContinuations = opts.maxContinuations ?? 10;

    while (this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      if (entry.isDlq) continue;

      const ctx: ExecutorContext = {
        tenantId,
        runId: entry.runId,
        deadlineAt: opts.deadlineAt ?? Date.now() + 10 * 60 * 1000, // 10 min default
        maxContinuations,
        // HOLE A FIX: thread the continuation count from the queue message into the
        // executor context. drive() uses ctx.continuationCount (NOT run.continuations)
        // to evaluate the maxContinuations guard — run.continuations is 0 from ensureRun
        // and never incremented by the queue, so the guard would permanently compute
        // nextContinuation=1 and never fire without this message-carried count.
        continuationCount: entry.continuationCount,
      };

      const msgKey = `${entry.runId}#${entry.continuationCount}`;

      if (this.redeliver && !this.processedOnce.has(msgKey)) {
        this.processedOnce.add(msgKey);
        // Re-deliver: push a copy back to the queue BEFORE processing
        this.pending.unshift({ ...entry });
      }

      await drive(ctx, deps);
    }
  }
}

// ---------------------------------------------------------------------------
// MemoryBus
// ---------------------------------------------------------------------------

interface BusSubscription {
  eventType: string;
  filters?: EventFilter[];
  handler: (e: DrahtEvent) => Promise<void>;
}

export class MemoryBus implements EventBus {
  private readonly subscriptions: BusSubscription[] = [];
  private readonly published: DrahtEvent[] = [];

  async publish(e: DrahtEvent): Promise<void> {
    // Guard: refuse past MAX_CHAIN_DEPTH
    if (e.chainDepth > MAX_CHAIN_DEPTH) {
      console.warn(
        `[MemoryBus] dropping event ${e.eventType}: chainDepth ${e.chainDepth} > MAX_CHAIN_DEPTH ${MAX_CHAIN_DEPTH}`,
      );
      return;
    }
    this.published.push(e);
    for (const sub of this.subscriptions) {
      if (sub.eventType !== e.eventType) continue;
      if (sub.filters && !matchesFilter(e, sub.filters)) continue;
      // best-effort, never throws into the caller
      sub.handler(e).catch((err: unknown) => {
        console.error("[MemoryBus] subscriber error:", err);
      });
    }
  }

  subscribe(
    p: { eventType: string; filters?: EventFilter[] },
    h: (e: DrahtEvent) => Promise<void>,
  ): void {
    const sub: BusSubscription = { eventType: p.eventType, handler: h };
    if (p.filters !== undefined) sub.filters = p.filters;
    this.subscriptions.push(sub);
  }

  get events(): DrahtEvent[] {
    return this.published;
  }
}

// ---------------------------------------------------------------------------
// MemoryTenancy
// ---------------------------------------------------------------------------

export class MemoryTenancy implements Tenancy {
  private readonly errorCounts = new Map<string, number>();
  private readonly breakerTripped = new Set<string>();
  private readonly usageLog: Array<{ tenantId: TenantId; usage: Usage; costUsd: number }> = [];

  async resolveTenant(): Promise<TenantId> {
    return DEFAULT_TENANT;
  }

  async checkQuota(_t: TenantId, _kind: "run"): Promise<{
    allowed: boolean;
    used: number;
    limit: number;
    remaining: number;
  }> {
    return { allowed: true, used: 0, limit: 1000, remaining: 1000 };
  }

  async recordUsage(t: TenantId, usage: Usage, costUsd: number): Promise<void> {
    this.usageLog.push({ tenantId: t, usage, costUsd });
  }

  async shouldBreak(t: TenantId, agentId: string): Promise<boolean> {
    const key = `${t}#${agentId}`;
    if (this.breakerTripped.has(key)) return true;
    const count = this.errorCounts.get(key) ?? 0;
    return count >= 5;
  }

  async tripBreaker(t: TenantId, agentId: string): Promise<void> {
    const key = `${t}#${agentId}`;
    this.breakerTripped.add(key);
  }

  /** For testing: increment error count. */
  incrementErrorCount(t: TenantId, agentId: string): void {
    const key = `${t}#${agentId}`;
    this.errorCounts.set(key, (this.errorCounts.get(key) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------
// FakeToolsDispatcher — constructor-injected scripted responses (tests only)
// ---------------------------------------------------------------------------

export type ToolHandler = (
  input: Record<string, unknown>,
  ctx: { idempotencyKey: string; tenantId: TenantId },
) => Promise<unknown>;

export class FakeToolsDispatcher implements ToolsDispatcher {
  private readonly handlers = new Map<string, ToolHandler>();
  private readonly callCounts = new Map<string, number>();
  /** toolRef → whether it has a side effect (for hasSideEffect pre-check logic). */
  private readonly sideEffectTools = new Set<string>();

  register(toolRef: string, handler: ToolHandler, hasSideEffect = true): void {
    this.handlers.set(toolRef, handler);
    if (hasSideEffect) this.sideEffectTools.add(toolRef);
  }

  async execute(
    toolRef: string,
    input: Record<string, unknown>,
    ctx: { idempotencyKey: string; tenantId: TenantId },
  ): Promise<unknown> {
    const count = (this.callCounts.get(toolRef) ?? 0) + 1;
    this.callCounts.set(toolRef, count);
    const handler = this.handlers.get(toolRef);
    if (!handler) throw new Error(`FakeToolsDispatcher: no handler registered for "${toolRef}"`);
    return handler(input, ctx);
  }

  hasSideEffect(toolRef: string): boolean {
    return this.sideEffectTools.has(toolRef);
  }

  getCallCount(toolRef: string): number {
    return this.callCounts.get(toolRef) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// FakeApprovalsCoordinator
// ---------------------------------------------------------------------------

export class FakeApprovalsCoordinator implements ApprovalsCoordinator {
  constructor(private readonly storage: MemoryStorage) {}

  async hold(params: {
    runId: RunId;
    tenantId: TenantId;
    nodeId: string;
    toolName: string;
    paramsJson: string;
    idempotencyKey: string;
  }): Promise<string> {
    // MAJOR 2 fix: check for an existing row for (runId, nodeId) BEFORE
    // minting a new actionId. MemoryStorage.createPendingApproval no-ops on a
    // duplicate (runId, stepId) — without this check, hold() would still
    // return the freshly-minted actionId even though it was never stored
    // (a "dangling" actionId the caller can never resolve or look up).
    const existing = await this.storage.getApprovalByStep(params.tenantId, params.runId, params.nodeId);
    if (existing !== null) return existing.actionId;

    // SECURITY FIX (CRITICAL 2): use crypto.randomUUID() to match the production
    // StorageApprovalsCoordinator's unguessable actionId scheme.
    const actionId = `action_${randomUUID()}`;
    const row: ApprovalRow = {
      runId: params.runId,
      stepId: params.nodeId,
      actionId,
      nodeId: params.nodeId,
      toolName: params.toolName,
      paramsJson: params.paramsJson,
      status: "pending",
      idempotencyKey: params.idempotencyKey,
    };
    await this.storage.createPendingApproval(row);
    return actionId;
  }
}

// ---------------------------------------------------------------------------
// LocalRuntime — implements the Runtime seam
// ---------------------------------------------------------------------------

interface LocalRuntimeDeps {
  storage: MemoryStorage;
  queue: MemoryQueue;
  eventBus: MemoryBus;
  tenancy: MemoryTenancy;
  model: Model;
  /**
   * Any ToolsDispatcher — FakeToolsDispatcher by default (tests), or a real
   * dispatcher (e.g. RealToolsDispatcher) injected by `platine dev` so the
   * user's authored tool `execute()` code actually runs in-process.
   */
  tools: ToolsDispatcher;
  approvals: FakeApprovalsCoordinator;
}

export class LocalRuntime implements Runtime {
  private readonly storage: MemoryStorage;
  private readonly queue: MemoryQueue;
  private readonly eventBus: MemoryBus;
  private readonly tenancy: MemoryTenancy;
  private readonly executorDeps: ExecutorDeps;
  private tenantId: TenantId;

  constructor(deps: LocalRuntimeDeps, tenantId: TenantId = DEFAULT_TENANT) {
    this.storage = deps.storage;
    this.queue = deps.queue;
    this.eventBus = deps.eventBus;
    this.tenancy = deps.tenancy;
    this.tenantId = tenantId;
    this.executorDeps = {
      model: deps.model,
      storage: deps.storage,
      eventBus: deps.eventBus,
      tenancy: deps.tenancy,
      queue: deps.queue,
      tools: deps.tools,
      approvals: deps.approvals,
    };
  }

  /**
   * submitRun — derives runId at the boundary (never inside executor),
   * pre-creates the RUN row, enqueues.
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

    // Only enqueue if not already terminal / awaiting / paused (idempotent)
    if (
      run.status === "queued" ||
      run.status === "running"
    ) {
      // Store the trigger input so the executor can load it
      await this.storage.appendCheckpoint({
        tenantId: i.tenantId,
        runId: i.runId,
        stepId: "__trigger__",
        status: "completed",
        output: { ...i.input, ...(i.trigger.payload ?? {}) },
      });

      run.chainDepth = i.chainDepth;
      this.queue.enqueue(i.runId);
    }

    return { status: run.status };
  }

  /**
   * resumeRun — handles approval/signal/continue.
   * For approval: resolves the approval row, re-enqueues.
   * For continue: re-enqueues directly.
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
        // Reset to running so drive() can continue
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        this.queue.enqueue(i.runId);
      } else {
        // Rejected: fail the run
        await this.storage.setRunStatus(this.tenantId, i.runId, "failed", {
          error: `Approval rejected by ${i.by ?? "unknown"}`,
        });
      }
    } else if (i.kind === "continue") {
      if (run.status === "paused" || run.status === "awaiting_approval") {
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        this.queue.enqueue(i.runId);
      }
    } else {
      // signal — not implemented in v1, treat as continue
      if (run.status === "paused") {
        await this.storage.setRunStatus(this.tenantId, i.runId, "running", {});
        this.queue.enqueue(i.runId);
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

  /**
   * drainQueue — convenience for tests: drain the queue and run all pending messages.
   */
  async drainQueue(opts: { deadlineAt?: number; maxContinuations?: number } = {}): Promise<void> {
    await this.queue.drain(this.executorDeps, {
      tenantId: this.tenantId,
      ...opts,
    });
  }
}

// ---------------------------------------------------------------------------
// createLocalRuntime — factory function for tests
// ---------------------------------------------------------------------------

/**
 * `T` defaults to FakeToolsDispatcher so every existing caller that omits
 * `tools` (or passes a FakeToolsDispatcher) keeps its exact prior static type
 * (including `.register()`/`.getCallCount()` on the returned `tools`).
 * Callers that inject a different ToolsDispatcher (e.g. `platine dev`'s
 * RealToolsDispatcher) get `T` inferred as that dispatcher's own type instead.
 */
export interface LocalRuntimeOptions<T extends ToolsDispatcher = FakeToolsDispatcher> {
  model: Model;
  tools?: T;
  tenantId?: TenantId;
}

export function createLocalRuntime<T extends ToolsDispatcher = FakeToolsDispatcher>(
  opts: LocalRuntimeOptions<T>,
): {
  runtime: LocalRuntime;
  storage: MemoryStorage;
  queue: MemoryQueue;
  bus: MemoryBus;
  tenancy: MemoryTenancy;
  tools: T;
  approvals: FakeApprovalsCoordinator;
} {
  const storage = new MemoryStorage();
  const queue = new MemoryQueue();
  const bus = new MemoryBus();
  const tenancy = new MemoryTenancy();
  // Safe: FakeToolsDispatcher satisfies the `T extends ToolsDispatcher` bound,
  // and is only ever used as the fallback when `opts.tools` (typed `T`) is absent.
  const tools = (opts.tools ?? new FakeToolsDispatcher()) as T;
  const approvals = new FakeApprovalsCoordinator(storage);
  const tenantId = opts.tenantId ?? DEFAULT_TENANT;

  const runtime = new LocalRuntime(
    { storage, queue, eventBus: bus, tenancy, model: opts.model, tools, approvals },
    tenantId,
  );

  return { runtime, storage, queue, bus, tenancy, tools, approvals };
}
