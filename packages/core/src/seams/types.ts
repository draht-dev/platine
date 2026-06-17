// SPDX-License-Identifier: Apache-2.0
// Shared record types used across multiple seams.

import type { TenantId, RunId, StepId } from "./ids.js";

// ─── Model types ─────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type ModelMessage =
  | { role: "system"; text: string }
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

// ─── Run / Step status ────────────────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "awaiting_approval"
  | "failed";

// ─── Storage record types ─────────────────────────────────────────────────────

export interface RunRecord {
  tenantId: TenantId;
  runId: RunId;
  manifestId: string;
  manifestRevision: string;
  status: RunStatus;
  chainDepth: number;
  attempt: number;
  continuations: number;
  steps: StepCheckpoint[];
  usage?: Usage;
  costUsd?: number;
  error?: string;
}

export interface StepCheckpoint {
  tenantId: TenantId;
  runId: RunId;
  stepId: StepId | string;
  status: StepStatus;
  input?: Record<string, unknown>;
  output?: unknown;
  idempotencyKey?: string;
  heldApprovalId?: string;
}

export interface SideEffectRow {
  tenantId: TenantId;
  runId: RunId;
  nodeId: string;
  idempotencyKey: string;
  toolName: string;
  result: unknown;
}

export interface ApprovalRow {
  runId: RunId;
  stepId: string;
  actionId: string;
  nodeId: string;
  toolName: string;
  paramsJson: string;
  status: "pending" | "approved" | "rejected";
  idempotencyKey: string;
  decidedBy?: string;
}

export interface FanoutItemRow {
  tenantId: TenantId;
  runId: RunId;
  nodeId: string;
  itemIndex: number;
  status: StepStatus;
  output?: unknown;
}

// ─── Event types ──────────────────────────────────────────────────────────────

export interface DrahtEvent {
  eventType: string;
  tenantId?: TenantId;
  chainDepth: number;
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * EventFilter — structurally identical to EventFilterZ inferred type from the manifest package.
 * { field: string; operator: "eq"|"neq"|"contains"|"regex"|"gt"|"gte"|"lt"|"lte"; value: string }
 * Do NOT import from the manifest package (different track owns it).
 */
export interface EventFilter {
  field: string;
  operator: "eq" | "neq" | "contains" | "regex" | "gt" | "gte" | "lt" | "lte";
  value: string;
}

// ─── Channel types ────────────────────────────────────────────────────────────

export interface TriggerEnvelope {
  type: "schedule" | "event" | "webhook" | "manual";
  eventType?: string;
  payload?: Record<string, unknown>;
  dedupKey?: string;
}

export interface InboundEnvelope {
  channelId: string;
  tenantHint?: string;
  payload: Record<string, unknown>;
  rawBody?: string;
}

export interface OutboundTarget {
  channelId: string;
  address: string;
}
