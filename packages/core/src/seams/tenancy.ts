// SPDX-License-Identifier: Apache-2.0
// Tenancy seam — single-tenant default in v1; the seam that unlocks multi-tenant.

import type { TenantId } from "./ids.js";
import type { InboundEnvelope, DrahtEvent, Usage } from "./types.js";

export interface Tenancy {
  /** DEFAULT_TENANT in v1 */
  resolveTenant(env: InboundEnvelope | DrahtEvent): Promise<TenantId>;

  checkQuota(
    t: TenantId,
    kind: "run",
  ): Promise<{ allowed: boolean; used: number; limit: number; remaining: number }>;

  recordUsage(t: TenantId, usage: Usage, costUsd: number): Promise<void>;

  /** errorCount >= 5 — v1, NOT deferred */
  shouldBreak(t: TenantId, agentId: string): Promise<boolean>;

  tripBreaker(t: TenantId, agentId: string): Promise<void>;
}
