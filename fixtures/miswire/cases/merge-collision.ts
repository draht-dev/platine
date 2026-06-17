// SPDX-License-Identifier: Apache-2.0
/**
 * merge-collision.ts — b.merge of two handles with a colliding discriminant key of
 * different literal types, then a downstream REQUIRED mapper reads the colliding
 * (now `never`) key into a typed slot.
 *
 * When TypeScript sees `{ kind: "a" } & { kind: "b" }`, it reduces the intersection
 * to `never` (TS2339: "The intersection ... was reduced to 'never' because property
 * 'kind' has conflicting types"). Any downstream mapper that accesses `m.kind` then
 * sees TS2339 at the read site.
 *
 * This is the CORRECT must-fix #4 pattern: collision is surfaced by forcing a required
 * downstream mapper to READ the never-typed intersection key. NOT an inert WiringError.
 *
 * Expected error: TS2339 — Property 'kind' does not exist on type 'never'.
 *                 (The intersection was reduced to 'never' due to conflicting 'kind'.)
 * The error MUST land on the line annotated with $ExpectError below.
 */

import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { defineWorkflow } from "@draht/core/define-workflow";

// Branch A produces { kind: "a"; name: string }
const branchA = defineTool({
  description: "Branch A result",
  inputSchema: z.object({ input: z.string() }),
  outputSchema: z.object({
    kind: z.literal("a"),
    name: z.string(),
  }),
  execute: async ({ input }) => ({ kind: "a" as const, name: input }),
});

// Branch B produces { kind: "b"; score: number }
const branchB = defineTool({
  description: "Branch B result",
  inputSchema: z.object({ input: z.string() }),
  outputSchema: z.object({
    kind: z.literal("b"),
    score: z.number(),
  }),
  execute: async ({ input }) => ({ kind: "b" as const, score: input.length }),
});

// Downstream requires a label derived from `kind`
const downstream = defineTool({
  description: "Downstream consumer",
  inputSchema: z.object({ label: z.string() }),
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async () => ({ ok: true }),
});

export default defineWorkflow((b) => {
  const t = b.trigger({
    type: "manual",
    payload: z.object({ input: z.string() }),
  });

  const a = b.node(branchA, t, (p) => ({ input: p.input }));
  const bh = b.node(branchB, t, (p) => ({ input: p.input }));

  // b.merge produces NodeHandle<{ kind: "a"; name: string } & { kind: "b"; score: number }>
  // TypeScript reduces this intersection to `never` because `kind: "a" & "b"` is impossible.
  const merged = b.merge(a, bh);

  // The downstream mapper MUST read `merged.kind` — but the intersection was reduced
  // to `never`, so `merged.kind` is TS2339.
  const _result = b.node(downstream, merged, (m) => ({
    label: m.kind, // $ExpectError TS2339
  }));

  return b.output(_result);
});
