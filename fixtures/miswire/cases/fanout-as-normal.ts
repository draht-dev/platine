// SPDX-License-Identifier: Apache-2.0
/**
 * fanout-as-normal.ts — a FanoutHandle (from b.split) is passed to b.node/b.transform
 * where a NodeHandle is required.
 *
 * FanoutHandle has `__fanout: true` while NodeHandle has `__fanout?: never`.
 * This structural incompatibility means FanoutHandle cannot be assigned to NodeHandle.
 *
 * This is the NEGATIVE brand guarantee (must-fix #3): the negative `__fanout?: never`
 * on NodeHandle is what makes tsc REJECT piping a fan-out branch into a normal node.
 * A positive-only brand would have leaked (FanoutHandle structurally assignable to
 * NodeHandle without the negative brand). See adversarial refutation probe5.
 *
 * Expected error: TS2345 — Argument of type 'FanoutHandle<string>' is not assignable
 *                           to parameter of type 'NodeHandle<...>'.
 *                 (or TS2322 depending on TypeScript version)
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

const processTool = defineTool({
  description: "Process a single item",
  inputSchema: z.object({ item: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  execute: async ({ item }) => ({ result: item.toUpperCase() }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ items: z.array(z.string()) }),
  });

  const items = b.transform(t, (p) => p.items);
  const fh = b.split(items);

  // fh is a FanoutHandle<string>. Passing it to b.node (which expects NodeHandle)
  // must be a compile-time error due to the negative __fanout brand.
  const _bad = b.node(processTool, fh, (item) => ({ item })); // $ExpectError TS2345

  return b.output(_bad);
});
