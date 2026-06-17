// SPDX-License-Identifier: Apache-2.0
/**
 * event-eventbridge.ts — EventBridgeBus implements EventBus.
 *
 * Publishes draht events to AWS EventBridge. Guards chainDepth to prevent
 * infinite event chains (refuses past MAX_CHAIN_DEPTH). Best-effort: errors
 * are logged but never thrown into the calling run.
 *
 * subscribe() is config-level only (EventBridge rules are declared in the SST
 * component at deploy time). In the Lambda handler, trigger rules route to the
 * trigger handler which creates a new run — subscribe() is a no-op here.
 */

import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";

import type { EventBus } from "@draht/core/seams";
import type { DrahtEvent, EventFilter } from "@draht/core/seams";
import { MAX_CHAIN_DEPTH, matchesFilter } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// EventBridgeBus
// ---------------------------------------------------------------------------

export class EventBridgeBus implements EventBus {
  private readonly client: EventBridgeClient;
  private readonly eventBusName: string;
  /** In-process subscribers (config-level only; subscribe() is a no-op in Lambda). */
  private readonly subscribers: Array<{
    eventType: string;
    filters?: EventFilter[];
    handler: (e: DrahtEvent) => Promise<void>;
  }> = [];

  /**
   * @param eventBusName  — EventBridge bus name or ARN
   * @param client        — injectable EventBridgeClient (use real client in prod; mock in tests)
   */
  constructor(eventBusName: string, client: EventBridgeClient) {
    this.eventBusName = eventBusName;
    this.client       = client;
  }

  /**
   * publish — puts the event onto EventBridge.
   *
   * chainDepth guard: refuses to publish if chainDepth > MAX_CHAIN_DEPTH.
   * Best-effort: errors are swallowed (logged) and never thrown into the caller.
   */
  async publish(e: DrahtEvent): Promise<void> {
    // Guard: refuse past MAX_CHAIN_DEPTH
    if (e.chainDepth > MAX_CHAIN_DEPTH) {
      console.warn(
        `[EventBridgeBus] dropping event ${e.eventType}: chainDepth ${e.chainDepth} > MAX_CHAIN_DEPTH ${MAX_CHAIN_DEPTH}`,
      );
      return;
    }

    const entry: PutEventsRequestEntry = {
      EventBusName: this.eventBusName,
      Source: "draht.runtime",
      DetailType: e.eventType,
      Detail: JSON.stringify(e),
    };

    try {
      const cmd = new PutEventsCommand({ Entries: [entry] });
      const result = await this.client.send(cmd);
      if ((result.FailedEntryCount ?? 0) > 0) {
        const failed = result.Entries?.filter((ent) => ent.ErrorCode != null) ?? [];
        console.error(
          `[EventBridgeBus] PutEvents partial failure for ${e.eventType}:`,
          JSON.stringify(failed),
        );
      }
    } catch (err) {
      // Best-effort: never throws into the run
      console.error(`[EventBridgeBus] PutEvents error for ${e.eventType}:`, err);
    }

    // Also dispatch to in-process subscribers (used in tests / platine dev)
    for (const sub of this.subscribers) {
      if (sub.eventType !== e.eventType) continue;
      if (sub.filters !== undefined && !matchesFilter(e, sub.filters)) continue;
      sub.handler(e).catch((err: unknown) => {
        console.error("[EventBridgeBus] in-process subscriber error:", err);
      });
    }
  }

  /**
   * subscribe — registers an in-process subscriber.
   * In the Lambda executor, this is a no-op (EventBridge rules handle routing at deploy time).
   * Useful in tests and `platine dev` mode.
   */
  subscribe(
    p: { eventType: string; filters?: EventFilter[] },
    h: (e: DrahtEvent) => Promise<void>,
  ): void {
    this.subscribers.push({
      eventType: p.eventType,
      handler: h,
      ...(p.filters !== undefined ? { filters: p.filters } : {}),
    });
  }
}
