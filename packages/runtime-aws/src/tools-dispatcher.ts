// SPDX-License-Identifier: Apache-2.0
/**
 * tools-dispatcher.ts — RealToolsDispatcher: executes the user's authored
 * tool `execute()` closures.
 *
 * The registry is built by @draht/core/compile::buildToolRegistry(WorkflowDef),
 * which walks the WorkflowDef's recorded nodes and keys each tool/unsafe node's
 * ToolDef by the IDENTICAL "tool_" + node.id scheme compile.ts uses for
 * `node.toolRef` / `manifest.tools[].toolId`. The ToolDef's `execute()` closure
 * lives ONLY on RecordedNode.def — it is never serialized into the Manifest —
 * so this registry (built from the WorkflowDef, not the Manifest) is the only
 * way the deployed executor can run the user's actual tool business logic.
 *
 * Input is validated against the tool's StandardSchemaV1 `inputSchema` (zod
 * schemas satisfy this via `"~standard"`) BEFORE `execute()` is invoked.
 */

import type { TenantId } from "@draht/core/seams";
import type { ToolDef, Schema } from "@draht/core/define-tool";
import type { ToolsDispatcher } from "./executor.js";

/** toolId ("tool_" + node.id) → ToolDef, as built by buildToolRegistry(). */
export type ToolRegistry = Map<string, ToolDef<Schema, Schema>>;

export class RealToolsDispatcher implements ToolsDispatcher {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    toolRef: string,
    input: Record<string, unknown>,
    ctx: { idempotencyKey: string; tenantId: TenantId },
  ): Promise<unknown> {
    const toolDef = this.registry.get(toolRef);
    if (!toolDef) {
      throw new Error(`[executor] no tool registered for ${toolRef}`);
    }

    // Validate BEFORE dispatch — a rejected input must never reach execute().
    const result = await toolDef.inputSchema["~standard"].validate(input);
    if (result.issues) {
      const detail = result.issues.map((issue) => issue.message).join("; ");
      throw new Error(`[executor] invalid input for tool ${toolRef}: ${detail}`);
    }

    return toolDef.execute(result.value, { idempotencyKey: ctx.idempotencyKey });
  }

  /** RealToolsDispatcher conservatively treats every registered tool as side-effecting. */
  hasSideEffect(_toolRef: string): boolean {
    return true;
  }
}
