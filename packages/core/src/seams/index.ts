// SPDX-License-Identifier: Apache-2.0
// @draht/core/seams — adapter seam interfaces (P3 implements concrete impls)
//
// Pure interfaces, ZERO AWS imports. All six seams live here:
//   Model, Storage, Runtime, Channel (InboundChannel + OutboundChannel), EventBus, Tenancy
//
// v2 Temporal/Restate swaps ONLY Runtime; reuses Model/Storage/Channel/EventBus/Tenancy unchanged.
// The Runtime seam is intentionally minimal: submit/resume/cancel/getRun only.
// No scheduling/level/fanout/continuation leaks into the seam (that's the whole point).

export type { TenantId, RunId, StepId } from "./ids.js";
export { DEFAULT_TENANT } from "./ids.js";

export type {
  ToolCall,
  ToolResult,
  ToolSpec,
  Usage,
  ModelMessage,
  RunStatus,
  StepStatus,
  RunRecord,
  StepCheckpoint,
  SideEffectRow,
  ApprovalRow,
  FanoutItemRow,
  DrahtEvent,
  EventFilter,
  TriggerEnvelope,
  InboundEnvelope,
  OutboundTarget,
} from "./types.js";

export type { ModelStreamEvent, ModelRequest, Model } from "./model.js";

export type { Storage } from "./storage.js";

export type { Runtime } from "./runtime.js";

export type { InboundChannel, OutboundChannel } from "./channel.js";

export type { EventBus } from "./event-bus.js";
export { matchesFilter, MAX_CHAIN_DEPTH } from "./event-bus.js";

export type { Tenancy } from "./tenancy.js";

// Adapters bundle — injected into the executor as one bundle.
// v2 Temporal/Restate swaps ONLY Runtime; reuses everything else unchanged.
import type { Model } from "./model.js";
import type { Storage } from "./storage.js";
import type { EventBus } from "./event-bus.js";
import type { Tenancy } from "./tenancy.js";
import type { InboundChannel, OutboundChannel } from "./channel.js";

export interface Adapters {
  model: Model;
  storage: Storage;
  eventBus: EventBus;
  tenancy: Tenancy;
  inbound: Record<string, InboundChannel>;
  outbound: Record<string, OutboundChannel>;
}
