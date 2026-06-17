// SPDX-License-Identifier: Apache-2.0
// @draht/core/define-tool — stub (P2 implements the full typed DSL)
//
// defineTool: one declaration → static type (z.infer) + model JSON Schema (z.toJSONSchema)
// Accepts any Standard Schema at the seam (<I extends StandardSchemaV1>), but ships/documents
// zod because only zod self-emits JSON Schema.
//
// NOTE: NO temperature/top_p/thinking params on opus-4-8/fable models — use an `effort` enum
// instead. This applies to defineAgent/defineWorkflow as well. (Built in P3, not P0.)

export {};
