// SPDX-License-Identifier: Apache-2.0
/**
 * executor.ts — level-scheduler executor behind the seams.
 *
 * Key durability invariants (all greenfield — §4 + Appendix A.2):
 * 1. deterministic runId at boundary BEFORE enqueue; drive() patches-not-creates + no-ops on redelivery
 * 2. mandatory SIDEEFFECT# pre-check on every tool dispatch, co-written with step-completed
 * 3. Engine-3 flush chain: checkpoints serialize on per-run promise chain; DRAIN before terminal writes
 * 4. soft time budget: drain + enqueue continuation under same anchor; maxContinuations → DLQ/fail
 * 5. approval hold: write APPROVAL# row, drain, RETURN (zero compute while held, NO re-enqueue)
 * 6. circuit breaker: tenancy.shouldBreak (errorCount >= 5) → pause
 * 7. chainDepth guard: MAX_CHAIN_DEPTH refused on EventBus publish
 *
 * Sub-step (mid-agent-loop) checkpointing is explicitly v2.
 * The ledger is the ONLY double-effect guard for in-node tool calls (v1 scope).
 */

import { createHash } from "node:crypto";
import { ssrfSafeFetch } from "./ssrf.js";
import type { Manifest } from "@draht/core/manifest";
import { parseManifest } from "@draht/core/manifest";
import type {
  TenantId,
  RunId,
  RunStatus,
  Usage,
  ToolSpec,
  ToolCall,
  ToolResult,
  ModelMessage,
  StepCheckpoint,
  SideEffectRow,
  ApprovalRow,
  DrahtEvent,
} from "@draht/core/seams";
import { MAX_CHAIN_DEPTH } from "@draht/core/seams";
import type { Storage } from "@draht/core/seams";
import type { Model } from "@draht/core/seams";
import type { EventBus } from "@draht/core/seams";
import type { Tenancy } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Internal queue interface (SQS in prod, MemoryQueue in local). */
export interface Queue {
  enqueueContinuation(runId: RunId, continuationCount: number): Promise<void>;
  enqueueDeadLetter(runId: RunId, reason: string): Promise<void>;
}

/** Tool dispatcher — wraps local/mcp/http tool execution. */
export interface ToolsDispatcher {
  execute(
    toolRef: string,
    input: Record<string, unknown>,
    ctx: { idempotencyKey: string; tenantId: TenantId },
  ): Promise<unknown>;
  /** Returns whether a toolRef has a known side effect (true = must ledger). */
  hasSideEffect(toolRef: string): boolean;
}

/** Approval coordinator. */
export interface ApprovalsCoordinator {
  hold(params: {
    runId: RunId;
    tenantId: TenantId;
    nodeId: string;
    toolName: string;
    paramsJson: string;
    idempotencyKey: string;
  }): Promise<string>; // returns actionId
}

/** Full dependency bundle injected into drive(). */
export interface ExecutorDeps {
  model: Model;
  storage: Storage;
  eventBus: EventBus;
  tenancy: Tenancy;
  queue: Queue;
  tools: ToolsDispatcher;
  approvals: ApprovalsCoordinator;
}

/** Execution context derived from the SQS message / local invocation. */
export interface ExecutorContext {
  tenantId: TenantId;
  runId: RunId;
  deadlineAt: number; // epoch ms; drive() drains + re-enqueues continuation when Date.now() >= deadlineAt
  maxContinuations: number; // cap to prevent infinite continuation loops
  /**
   * The continuation count carried on the queue message (SQS message attribute /
   * MemoryQueue entry). The initial enqueue uses 0. Each re-enqueue increments by 1.
   * drive() uses THIS value (not run.continuations) to evaluate the maxContinuations
   * guard, because run.continuations is set to 0 by ensureRun and is only written
   * for observability — the authoritative count lives on the in-flight message.
   */
  continuationCount: number;
}

// ---------------------------------------------------------------------------
// Deterministic runId derivation (pure, sha256-based)
// ---------------------------------------------------------------------------

/** deriveRunId — pure, computed at the trigger boundary, NEVER inside drive(). */
export function deriveRunId(triggerSource: string, dedupKey: string): RunId {
  return createHash("sha256")
    .update(`${triggerSource}\0${dedupKey}`)
    .digest("hex")
    .slice(0, 40) as RunId;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Returns the nodeIds of direct upstream nodes (sources of edges targeting nodeId). */
function upstreamNodes(manifest: Manifest, nodeId: string): string[] {
  return manifest.edges
    .filter((e) => e.target === nodeId)
    .map((e) => e.source);
}

/**
 * Resolve the input for a node from accumulated outputs.
 * - first node (no upstreams): uses trigger input stored in outputs.get("__trigger__")
 * - single upstream: output of that node
 * - multiple upstreams (merge): merge all upstream outputs shallowly
 */
function resolveInput(
  nodeId: string,
  manifest: Manifest,
  outputs: Map<string, unknown>,
): Record<string, unknown> {
  const ups = upstreamNodes(manifest, nodeId);
  if (ups.length === 0) {
    const trigger = outputs.get("__trigger__");
    return (trigger as Record<string, unknown>) ?? {};
  }
  if (ups.length === 1) {
    const up = ups[0]!;
    return (outputs.get(up) as Record<string, unknown>) ?? {};
  }
  // merge: shallow merge of all upstream outputs
  let merged: Record<string, unknown> = {};
  for (const up of ups) {
    const o = (outputs.get(up) as Record<string, unknown>) ?? {};
    merged = { ...merged, ...o };
  }
  return merged;
}

/**
 * Effective approval flag: node-level overrides tool-level.
 * For tool nodes: node.requiresApproval overrides the tool registry entry.
 */
function effectiveApproval(
  node: Manifest["nodes"][number],
  manifest: Manifest,
): boolean {
  if (node.kind !== "tool") return false;
  // node-level is the canonical override (always present after schema default)
  if (node.requiresApproval) return true;
  // fall back to tool registry
  const toolDef = manifest.tools.find((t) => t.toolId === node.toolRef);
  return toolDef?.requiresApproval ?? false;
}

function logFlushErr(err: unknown): void {
  console.error("[executor] checkpoint flush error:", err);
}

/** Accumulate usage deltas from step results into the run's accumulated usage. */
function accumulateUsage(
  acc: { usage?: Usage; costUsd?: number },
  delta: { usage?: Usage; costUsd?: number },
): void {
  if (delta.usage) {
    const existing = acc.usage ?? { inputTokens: 0, outputTokens: 0 };
    acc.usage = {
      inputTokens: existing.inputTokens + delta.usage.inputTokens,
      outputTokens: existing.outputTokens + delta.usage.outputTokens,
      ...(delta.usage.cacheReadTokens !== undefined ||
      (existing.cacheReadTokens !== undefined)
        ? {
            cacheReadTokens:
              (existing.cacheReadTokens ?? 0) +
              (delta.usage.cacheReadTokens ?? 0),
          }
        : {}),
    };
  }
  if (delta.costUsd !== undefined) {
    acc.costUsd = (acc.costUsd ?? 0) + delta.costUsd;
  }
}

// ---------------------------------------------------------------------------
// StepResult union
// ---------------------------------------------------------------------------

type StepResult =
  | { kind: "done"; nodeId: string; output: unknown; fanoutHandled?: string[]; usage?: Usage; costUsd?: number }
  | { kind: "held"; nodeId: string; approvalId: string }
  | { kind: "failed"; nodeId: string; error: string };

// ---------------------------------------------------------------------------
// runStep — executes a single node
// ---------------------------------------------------------------------------

async function runStep(
  node: Manifest["nodes"][number],
  outputs: Map<string, unknown>,
  manifest: Manifest,
  ctx: ExecutorContext,
  deps: ExecutorDeps,
  checkpoint: (r: StepCheckpoint) => void,
): Promise<StepResult> {
  const { storage, tools, approvals, model } = deps;
  const input = resolveInput(node.nodeId, manifest, outputs);
  const idemKey = `${ctx.runId}#${node.nodeId}`;

  // ── tool node ──────────────────────────────────────────────────────────────
  if (node.kind === "tool") {
    // Approval check first (node-level overrides tool-level).
    // IMPORTANT: before holding, check if approval was already granted for this
    // (runId, nodeId). If an approved row exists, skip the hold and fall through
    // to the side-effect pre-check + tool dispatch. This prevents the re-hold loop
    // (plan §588: approval granted → resume → tool runs → completes).
    if (effectiveApproval(node, manifest)) {
      const existingApproval = await storage.getApprovalByStep(ctx.tenantId, ctx.runId, node.nodeId);
      if (existingApproval?.status !== "approved") {
        // No granted approval — hold and wait
        const paramsJson = JSON.stringify(input);
        const actionId = await approvals.hold({
          runId: ctx.runId,
          tenantId: ctx.tenantId,
          nodeId: node.nodeId,
          toolName: node.toolRef,
          paramsJson,
          idempotencyKey: idemKey,
        });
        checkpoint({
          tenantId: ctx.tenantId,
          runId: ctx.runId,
          stepId: node.nodeId,
          status: "awaiting_approval",
          input: input as Record<string, unknown>,
          heldApprovalId: actionId,
          idempotencyKey: idemKey,
        });
        return { kind: "held", nodeId: node.nodeId, approvalId: actionId };
      }
      // Approval already granted — fall through to side-effect pre-check + dispatch
    }

    // Mandatory SIDEEFFECT# pre-check before dispatch
    const prior = await storage.hasSideEffect(ctx.tenantId, ctx.runId, node.nodeId);
    if (prior) {
      // Already executed — return the ledgered result without re-running
      return { kind: "done", nodeId: node.nodeId, output: prior.result, fanoutHandled: [] };
    }

    // Execute the tool
    const out = await tools.execute(node.toolRef, input, {
      idempotencyKey: idemKey,
      tenantId: ctx.tenantId,
    });

    // Atomic step-completed + SIDEEFFECT# co-write
    const stepRecord: StepCheckpoint = {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepId: node.nodeId,
      status: "completed",
      input: input as Record<string, unknown>,
      output: out,
      idempotencyKey: idemKey,
    };
    const ledger: SideEffectRow = {
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      nodeId: node.nodeId,
      idempotencyKey: idemKey,
      toolName: node.toolRef,
      result: out,
    };
    await storage.commitStepWithSideEffect(stepRecord, ledger);
    return { kind: "done", nodeId: node.nodeId, output: out };
  }

  // ── agent node ─────────────────────────────────────────────────────────────
  if (node.kind === "agent") {
    // Mandatory SIDEEFFECT# pre-check (agents can have side effects via tools)
    const priorAgent = await storage.hasSideEffect(ctx.tenantId, ctx.runId, node.nodeId);
    if (priorAgent) {
      return { kind: "done", nodeId: node.nodeId, output: priorAgent.result };
    }

    const agentDef = manifest.agent;
    // Build tool specs from manifest for the agent
    const toolSpecs: ToolSpec[] = manifest.tools.map((t) => ({
      name: t.toolId,
      description: t.description,
      inputSchema: {
        type: "object" as const,
        properties: t.inputSchema.properties as Record<string, unknown>,
        required: t.inputSchema.required,
      },
    }));

    const systemMsg: ModelMessage = {
      role: "system",
      text: agentDef.instructionsRef.inline ?? "You are a helpful assistant.",
    };
    const userMsg: ModelMessage = {
      role: "user",
      text: JSON.stringify(input),
    };

    const messages: ModelMessage[] = [systemMsg, userMsg];
    const maxIter = agentDef.maxIterations;
    const maxToolCalls = agentDef.maxToolCallsPerIteration;

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let finalText = "";
    let iterations = 0;

    // Bounded model tool-loop
    // Sub-step (mid-loop) checkpointing is explicitly v2.
    // The ledger is the only double-effect guard for in-loop tool calls.
    while (iterations < maxIter) {
      iterations++;
      const modelReq = toolSpecs.length > 0
        ? {
            modelId: `${agentDef.model.provider}/${agentDef.model.modelId}`,
            messages,
            tools: toolSpecs,
            maxTokens: agentDef.model.maxOutputTokens ?? 4096,
          }
        : {
            modelId: `${agentDef.model.provider}/${agentDef.model.modelId}`,
            messages,
            maxTokens: agentDef.model.maxOutputTokens ?? 4096,
          };
      const result = await model.chat(modelReq);

      // Accumulate usage
      usage = {
        inputTokens: usage.inputTokens + result.usage.inputTokens,
        outputTokens: usage.outputTokens + result.usage.outputTokens,
      };
      finalText = result.text;

      if (result.stopReason === "end_turn" || result.toolCalls.length === 0) {
        break;
      }

      // Tool calls — allowlist check + bounded dispatch
      const allowedCalls = result.toolCalls.slice(0, maxToolCalls);
      const toolResults: ToolResult[] = [];

      for (const call of allowedCalls) {
        const toolDef = manifest.tools.find((t) => t.toolId === call.name);
        if (!toolDef) {
          toolResults.push({
            toolUseId: call.id,
            content: `Unknown tool: ${call.name}`,
            isError: true,
          });
          continue;
        }

        // Approval check at tool dispatch level within agent loop
        if (effectiveApprovalForAgentTool(call.name, manifest)) {
          // For agent-internal tool calls requiring approval, we surface as a held result
          // The whole agent node gets held; this is a simplification — v2 will checkpoint mid-loop
          const agentToolKey = `${ctx.runId}#${node.nodeId}#${call.name}`;
          const actionId = await approvals.hold({
            runId: ctx.runId,
            tenantId: ctx.tenantId,
            nodeId: node.nodeId,
            toolName: call.name,
            paramsJson: JSON.stringify(call.input),
            idempotencyKey: agentToolKey,
          });
          checkpoint({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            stepId: node.nodeId,
            status: "awaiting_approval",
            heldApprovalId: actionId,
            idempotencyKey: agentToolKey,
          });
          return { kind: "held", nodeId: node.nodeId, approvalId: actionId };
        }

        // Ledger pre-check for in-loop tool calls
        const toolKey = `${ctx.runId}#${node.nodeId}#${call.id}`;
        const priorTool = await storage.hasSideEffect(ctx.tenantId, ctx.runId, `${node.nodeId}#${call.id}`);
        if (priorTool) {
          toolResults.push({
            toolUseId: call.id,
            content: typeof priorTool.result === "string"
              ? priorTool.result
              : JSON.stringify(priorTool.result),
          });
          continue;
        }

        try {
          const toolOut = await tools.execute(call.name, call.input as Record<string, unknown>, {
            idempotencyKey: toolKey,
            tenantId: ctx.tenantId,
          });
          // Commit in-loop tool call to ledger
          await storage.commitStepWithSideEffect(
            {
              tenantId: ctx.tenantId,
              runId: ctx.runId,
              stepId: `${node.nodeId}#${call.id}`,
              status: "completed",
              output: toolOut,
              idempotencyKey: toolKey,
            },
            {
              tenantId: ctx.tenantId,
              runId: ctx.runId,
              nodeId: `${node.nodeId}#${call.id}`,
              idempotencyKey: toolKey,
              toolName: call.name,
              result: toolOut,
            },
          );
          toolResults.push({
            toolUseId: call.id,
            content: typeof toolOut === "string" ? toolOut : JSON.stringify(toolOut),
          });
        } catch (err) {
          toolResults.push({
            toolUseId: call.id,
            content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        }
      }

      // Append assistant turn + tool results
      messages.push({
        role: "assistant",
        text: result.text,
        toolCalls: allowedCalls as ToolCall[],
      });
      messages.push({ role: "tool", results: toolResults });
    }

    // Commit the agent node result
    const agentOut: Record<string, unknown> = { text: finalText };
    await storage.commitStepWithSideEffect(
      {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepId: node.nodeId,
        status: "completed",
        input: input as Record<string, unknown>,
        output: agentOut,
        idempotencyKey: idemKey,
      },
      {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        nodeId: node.nodeId,
        idempotencyKey: idemKey,
        toolName: node.agentRef,
        result: agentOut,
      },
    );
    return { kind: "done", nodeId: node.nodeId, output: agentOut, usage };
  }

  // ── transform node ─────────────────────────────────────────────────────────
  if (node.kind === "transform") {
    const t = node.transform;
    let out: unknown;

    if (t.type === "map") {
      const mapped: Record<string, unknown> = {};
      for (const m of t.mappings) {
        // Simple dot-path resolution for 'from' key
        const val = resolvePath(input, m.from);
        setPath(mapped, m.to, val);
      }
      out = mapped;
    } else if (t.type === "filter") {
      // Returns the input if passes, else undefined (node skipped)
      const val = resolvePath(input, t.field);
      const valStr = val === undefined || val === null ? "" : String(val);
      const passes = evalFilterOp(t.operator, valStr, t.value);
      out = passes ? input : undefined;
    } else if (t.type === "split") {
      // Split: returns the array field value as-is for fanout
      out = resolvePath(input, t.arrayField);
    } else if (t.type === "http_request") {
      // HOLE C2 FIX: http_request transforms issue a real fetch (external side effect).
      // Unlike map/filter/split (pure), a redelivery after crash-before-drain would
      // re-run the fetch (probe reproduced fires=2). Route http_request through the
      // SAME hasSideEffect pre-check + commitStepWithSideEffect atomic co-write that
      // tool nodes use, so http_request is exactly-once at the step boundary.
      const priorHttp = await storage.hasSideEffect(ctx.tenantId, ctx.runId, node.nodeId);
      if (priorHttp) {
        // Already executed — return the ledgered result without re-fetching
        return { kind: "done", nodeId: node.nodeId, output: priorHttp.result };
      }
      try {
        const body = t.bodyTemplate
          ? interpolateTemplate(t.bodyTemplate, input)
          : undefined;
        const fetchInit: RequestInit = {
          method: t.method,
          headers: t.headers ?? {},
        };
        if (body !== undefined) {
          fetchInit.body = body;
        }
        // SECURITY FIX (HIGH 3): use ssrfSafeFetch instead of raw fetch.
        // Raw fetch allows requests to 169.254.169.254 (IMDS), RFC1918 addresses,
        // and follows redirects, enabling SSRF attacks that could steal AWS credentials.
        const resp = await ssrfSafeFetch(t.url, fetchInit);
        out = await resp.json() as unknown;
      } catch (err) {
        return {
          kind: "failed",
          nodeId: node.nodeId,
          error: `http_request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Atomic step-completed + SIDEEFFECT# co-write (same contract as tool nodes)
      const httpStepRecord: StepCheckpoint = {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        stepId: node.nodeId,
        status: "completed",
        input: input as Record<string, unknown>,
        output: out,
      };
      const httpLedger: SideEffectRow = {
        tenantId: ctx.tenantId,
        runId: ctx.runId,
        nodeId: node.nodeId,
        idempotencyKey: idemKey,
        toolName: `http_request:${t.method}:${t.url}`,
        result: out,
      };
      await storage.commitStepWithSideEffect(httpStepRecord, httpLedger);
      return { kind: "done", nodeId: node.nodeId, output: out };
    } else {
      out = input;
    }

    checkpoint({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepId: node.nodeId,
      status: "completed",
      input: input as Record<string, unknown>,
      output: out,
    });
    return { kind: "done", nodeId: node.nodeId, output: out };
  }

  // ── fanout node ─────────────────────────────────────────────────────────────
  if (node.kind === "fanout") {
    // The upstream split transform should have produced an array
    const items = (input as { __items?: unknown[] }).__items ?? (Array.isArray(input) ? input : []);
    const concurrency = node.concurrency;

    // Run items in bounded concurrency batches, with per-item checkpoints (resumable)
    const results: unknown[] = new Array(items.length) as unknown[];
    let i = 0;

    while (i < items.length) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (item, batchIdx) => {
          const idx = i + batchIdx;
          const fanoutKey = `FANOUT#${node.nodeId}#${idx}`;
          // Per-item checkpoint
          checkpoint({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            stepId: fanoutKey,
            status: "running",
            input: { item, index: idx },
          });
          // Process through elementSubgraph (simplified: pass item through)
          const itemOut = item;
          checkpoint({
            tenantId: ctx.tenantId,
            runId: ctx.runId,
            stepId: fanoutKey,
            status: "completed",
            output: itemOut,
          });
          return { idx, output: itemOut };
        }),
      );
      for (const r of batchResults) {
        results[r.idx] = r.output;
      }
      i += concurrency;
    }

    checkpoint({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      stepId: node.nodeId,
      status: "completed",
      output: results,
    });

    return { kind: "done", nodeId: node.nodeId, output: results, fanoutHandled: [] };
  }

  // Unknown node kind (exhaustiveness fallthrough)
  const unknownNode = node as { nodeId: string; kind: string };
  return { kind: "failed", nodeId: unknownNode.nodeId, error: `Unknown node kind: ${unknownNode.kind}` };
}

/** Check if a tool called by name within an agent node requires approval. */
function effectiveApprovalForAgentTool(toolName: string, manifest: Manifest): boolean {
  const toolDef = manifest.tools.find((t) => t.toolId === toolName);
  return toolDef?.requiresApproval ?? false;
}

/** Shallow dot-path resolution: "a.b.c" → value. */
function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Set a value at a dot-path in an object (mutates). */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== "object" || cur[p] === null) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  cur[last] = value;
}

/** Evaluate a filter operator on stringified values. */
function evalFilterOp(operator: string, fieldStr: string, filterValue: string): boolean {
  switch (operator) {
    case "eq": return fieldStr === filterValue;
    case "neq": return fieldStr !== filterValue;
    case "contains": return fieldStr.includes(filterValue);
    case "regex": try { return new RegExp(filterValue).test(fieldStr); } catch { return false; }
    case "gt": return Number(fieldStr) > Number(filterValue);
    case "gte": return Number(fieldStr) >= Number(filterValue);
    case "lt": return Number(fieldStr) < Number(filterValue);
    case "lte": return Number(fieldStr) <= Number(filterValue);
    default: return false;
  }
}

/** Simple {{field}} template interpolation. */
function interpolateTemplate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = ctx[key];
    return val === undefined ? "" : String(val);
  });
}

// ---------------------------------------------------------------------------
// failRun — set run to failed, flush first (safe: flush errors do not prevent the fail write)
// ---------------------------------------------------------------------------

async function failRun(
  ctx: ExecutorContext,
  storage: Storage,
  flush: Promise<void>,
  reason: string,
): Promise<void> {
  // Drain the flush chain best-effort; errors already logged by checkpoint's .catch.
  // We MUST write the failed status even if some checkpoints failed to persist.
  await flush.catch(() => { /* already logged */ });
  await storage.setRunStatus(ctx.tenantId, ctx.runId, "failed", { error: reason });
}

// ---------------------------------------------------------------------------
// drive() — main entry point
// ---------------------------------------------------------------------------

/**
 * drive() — executes a run up to the next terminal state.
 *
 * Idempotent: no-ops if status is terminal / awaiting_approval / paused.
 * Called by the SQS Lambda handler (or MemoryQueue in local mode).
 */
export async function drive(ctx: ExecutorContext, deps: ExecutorDeps): Promise<void> {
  const { storage, tenancy, queue, eventBus } = deps;

  const run = await storage.getRun(ctx.tenantId, ctx.runId);
  if (!run) return; // no-op: run doesn't exist
  if (isTerminal(run.status) || run.status === "awaiting_approval" || run.status === "paused") {
    return; // idempotent no-op on redelivery
  }

  // Circuit breaker check
  if (await tenancy.shouldBreak(ctx.tenantId, run.manifestId)) {
    await storage.setRunStatus(ctx.tenantId, ctx.runId, "paused", {});
    return;
  }

  // Load PINNED manifest revision (never the live one)
  const manifestBlob = await storage.loadManifest(run.manifestId, run.manifestRevision);
  const manifest = parseManifest(JSON.parse(manifestBlob) as unknown);

  // Rehydrate step outputs from storage (never a single previousOutput)
  const outputs = await storage.loadStepOutputs(ctx.tenantId, ctx.runId);

  // Compute which nodes are already done (only manifest nodes, not __trigger__ or FANOUT# etc.)
  const manifestNodeIds = new Set(manifest.nodes.map((n) => n.nodeId));
  const done = new Set<string>(
    run.steps
      .filter(
        (s) => (s.status === "completed" || s.status === "skipped") && manifestNodeIds.has(String(s.stepId)),
      )
      .map((s) => String(s.stepId)),
  );

  // Engine-3 flush chain: all checkpoints serialize on this per-run promise chain.
  // IMPORTANT: flush errors are NOT swallowed. We capture the first error so that
  // a failed appendCheckpoint (e.g. DynamoDB conditional-check failure) causes the
  // run to fail rather than silently completing with missing step data.
  let flush: Promise<void> = Promise.resolve();
  let flushError: unknown = undefined;
  const checkpoint = (r: StepCheckpoint): void => {
    flush = flush.then(() => storage.appendCheckpoint(r)).catch((err: unknown) => {
      logFlushErr(err);
      if (flushError === undefined) flushError = err;
      // Re-throw so the chain stays rejected and callers of flush see the error
      throw err;
    });
  };

  // Accumulated usage for this drive() invocation
  const usageAcc: { usage?: Usage; costUsd?: number } = {};
  if (run.usage !== undefined) usageAcc.usage = run.usage;
  if (run.costUsd !== undefined) usageAcc.costUsd = run.costUsd;

  // Main scheduling loop
  while (done.size < manifest.nodes.length) {
    // Soft time budget: drain + enqueue continuation
    if (Date.now() >= ctx.deadlineAt) {
      await flush.catch(() => { /* already logged */ });
      if (flushError !== undefined) {
        const msg = flushError instanceof Error ? flushError.message : String(flushError);
        await storage.setRunStatus(ctx.tenantId, ctx.runId, "failed", {
          error: `checkpoint flush failed: ${msg}`,
        });
        return;
      }
      // HOLE A FIX: use the message-carried continuationCount (ctx.continuationCount),
      // NOT run.continuations. run.continuations is 0 from ensureRun and never bumped
      // by drive() or MemoryQueue.drain, so using it would keep nextContinuation at 1
      // forever and the guard would never fire (infinite continuation loop).
      // The authoritative continuation count is on the queue message (SQS attribute /
      // MemoryQueue entry.continuationCount), propagated here via ctx.continuationCount.
      const nextContinuation = ctx.continuationCount + 1;
      // Persist continuationCount onto the run row for observability (getRun reflects it).
      // The GUARD must key off ctx.continuationCount, not run.continuations.
      run.continuations = ctx.continuationCount;
      if (nextContinuation > ctx.maxContinuations) {
        // maxContinuations exceeded → DLQ / fail (no infinite loop)
        await queue.enqueueDeadLetter(ctx.runId, "maxContinuations exceeded");
        await storage.setRunStatus(ctx.tenantId, ctx.runId, "failed", {
          error: `maxContinuations (${ctx.maxContinuations}) exceeded`,
        });
        return;
      }
      await queue.enqueueContinuation(ctx.runId, nextContinuation);
      return;
    }

    // Find ready nodes: all upstreams done
    const ready = manifest.nodes.filter(
      (n) =>
        !done.has(n.nodeId) &&
        upstreamNodes(manifest, n.nodeId).every((u) => done.has(u)),
    );

    if (ready.length === 0) {
      // Scheduling stall — graph has cycles or dangling edges
      await failRun(ctx, storage, flush, "scheduling stalled: no ready nodes");
      return;
    }

    // Run ready nodes concurrently (Promise.all per level)
    const results = await Promise.all(
      ready.map((n) => runStep(n, outputs, manifest, ctx, deps, checkpoint)),
    );

    // Accumulate usage deltas POST-Promise.all (no shared-accumulator race)
    for (const r of results) {
      if (r.kind === "done") {
        accumulateUsage(usageAcc, r);
      }
    }

    // Process results
    let held = false;
    let failed = false;
    let failReason = "";

    for (const r of results) {
      if (r.kind === "held") {
        held = true;
        break;
      }
      if (r.kind === "failed") {
        failed = true;
        failReason = r.error;
        break;
      }
    }

    if (held) {
      await flush.catch(() => { /* already logged */ });
      if (flushError !== undefined) {
        const msg = flushError instanceof Error ? flushError.message : String(flushError);
        await storage.setRunStatus(ctx.tenantId, ctx.runId, "failed", {
          error: `checkpoint flush failed: ${msg}`,
        });
        return;
      }
      await storage.setRunStatus(ctx.tenantId, ctx.runId, "awaiting_approval", {});
      return; // ZERO compute while held; NO re-enqueue
    }

    if (failed) {
      await failRun(ctx, storage, flush, failReason);
      return;
    }

    // Mark completed nodes and collect outputs
    for (const r of results) {
      if (r.kind === "done") {
        outputs.set(r.nodeId, r.output);
        done.add(r.nodeId);
        // Mark split descendants done after settle
        if (r.fanoutHandled) {
          for (const h of r.fanoutHandled) {
            done.add(h);
          }
        }
      }
    }
  }

  // All nodes done — drain BEFORE terminal status write.
  // If the flush chain has a pending error, surface it now instead of silently completing
  // with lost checkpoints (HOLE #2 fix: do NOT swallow flush errors that gate a terminal write).
  await flush.catch(() => { /* already logged by checkpoint's .catch */ });
  if (flushError !== undefined) {
    const msg = flushError instanceof Error ? flushError.message : String(flushError);
    await storage.setRunStatus(ctx.tenantId, ctx.runId, "failed", {
      error: `checkpoint flush failed: ${msg}`,
    });
    return;
  }
  const finalFin: { usage?: Usage; costUsd?: number } = {};
  if (usageAcc.usage !== undefined) finalFin.usage = usageAcc.usage;
  if (usageAcc.costUsd !== undefined) finalFin.costUsd = usageAcc.costUsd;
  await storage.setRunStatus(ctx.tenantId, ctx.runId, "completed", finalFin);

  // Emit outputs to EventBus with chainDepth+1 (chainDepth guard: refuse past MAX_CHAIN_DEPTH)
  if (run.chainDepth < MAX_CHAIN_DEPTH) {
    const finalOutput = outputs.get(manifest.nodes[manifest.nodes.length - 1]?.nodeId ?? "");
    if (finalOutput !== undefined) {
      const event: DrahtEvent = {
        eventType: `${manifest.agent.agentId}.completed`,
        tenantId: ctx.tenantId,
        chainDepth: run.chainDepth + 1,
        payload: finalOutput as Record<string, unknown>,
      };
      // best-effort, never throws into the run
      eventBus.publish(event).catch((err: unknown) => {
        console.error("[executor] eventBus.publish error (best-effort):", err);
      });
    }
  }
}
