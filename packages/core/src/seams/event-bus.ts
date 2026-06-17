// SPDX-License-Identifier: Apache-2.0
// EventBus seam — chainDepth loop guard; filter eval lives HERE not in the compiler.

import type { DrahtEvent, EventFilter } from "./types.js";

export const MAX_CHAIN_DEPTH = 10;

export interface EventBus {
  /** refuses past MAX_CHAIN_DEPTH; best-effort, never throws into the run */
  publish(e: DrahtEvent): Promise<void>;
  subscribe(
    p: { eventType: string; filters?: EventFilter[] },
    h: (e: DrahtEvent) => Promise<void>,
  ): void;
}

/**
 * matchesFilter — AND-logic, string-coerced field comparison.
 * All operators operate on the stringified field value from the event payload.
 */
export function matchesFilter(e: DrahtEvent, filters: EventFilter[]): boolean {
  for (const f of filters) {
    const raw = (e.payload as Record<string, unknown>)[f.field];
    const fieldStr = raw === undefined || raw === null ? "" : String(raw);
    const passes = evalOperator(f.operator, fieldStr, f.value);
    if (!passes) return false;
  }
  return true;
}

function evalOperator(
  operator: EventFilter["operator"],
  fieldStr: string,
  filterValue: string,
): boolean {
  switch (operator) {
    case "eq":
      return fieldStr === filterValue;
    case "neq":
      return fieldStr !== filterValue;
    case "contains":
      return fieldStr.includes(filterValue);
    case "regex": {
      try {
        return new RegExp(filterValue).test(fieldStr);
      } catch {
        return false;
      }
    }
    case "gt":
      return Number(fieldStr) > Number(filterValue);
    case "gte":
      return Number(fieldStr) >= Number(filterValue);
    case "lt":
      return Number(fieldStr) < Number(filterValue);
    case "lte":
      return Number(fieldStr) <= Number(filterValue);
  }
}
