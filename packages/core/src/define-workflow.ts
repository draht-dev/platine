// SPDX-License-Identifier: Apache-2.0
// @draht/core/define-workflow — stub (P2 implements the full typed builder)
//
// defineWorkflow: typed DAG builder with single-call-site mapper functions.
// The builder primitive is b.node(def, from, mapper) — NOT b.pipe() or chain().
//
// CRITICAL DESIGN NOTES (locked per adversarial verification):
// 1. NO Pipe<Out,In>-as-return-type: WiringError-as-return-value is inert (errors one hop later at wrong line).
// 2. NO variadic chain(): a mid-chain mis-wire collapses Fold to `never` → silent tsc.
// 3. Fan-out brand is NEGATIVE on NodeHandle (__fanout?: never), not positive on FanoutHandle.
// 4. Merge collisions surface via a required downstream read of the never-typed intersection key.
// 5. In+Out inferred at ONE call site (not split across chained generic calls).
// 6. CI fixture suite in fixtures/miswire/ asserts each mis-wire errors at the expected line.

export {};
