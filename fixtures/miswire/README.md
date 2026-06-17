# fixtures/miswire — Type Error Gate

This package contains intentionally broken workflow definitions. Each file
represents a different mis-wire scenario. The CI job `type-fixtures.yml` asserts
that `tsc` reports an error at **the exact expected line** for each fixture.

## Purpose

The "readable error at the right location" guarantee regresses silently if the
`defineWorkflow` builder API shape changes — every broken variant can compile
clean if the wrong builder shape is used.

See the adversarial verification record (Appendix A.1) in the v1 plan for the
full empirical proof of why the builder must use single-call-site mapper functions
with a negative fan-out brand on `NodeHandle`.

## Fixture categories (P2 implements)

1. **wrong-field** — mapper accesses a field that doesn't exist on upstream output (TS2339)
2. **type-mismatch** — mapper returns a field with the wrong type (TS2322)
3. **missing-required** — mapper omits a required field (TS2741)
4. **fanout-piped-as-normal** — tries to pipe a FanoutHandle into a normal node (structural brand rejection)
5. **merge-collision** — merge of A & B where a key type is `never`; required downstream read fails
6. **mid-chain-break** — a chain with a broken middle hop (each hop must error at its own site)

## Running locally

```bash
pnpm --filter @draht/fixtures-miswire typecheck
# Each fixture should report tsc errors — that's the expected outcome.
```

The CI runner `scripts/assert-type-errors.ts` (added in P2) verifies that each
fixture errors at the expected line number.
