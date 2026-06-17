// SPDX-License-Identifier: Apache-2.0
// @draht/core/manifest — Manifest schema, types, and validation (P1 implements)
//
// Single source of truth: zod schema (ManifestZ), inferred type (Manifest), and parseManifest().
// Both the SST component (Pulumi-program time) and the Runtime (execution time) import from here.
// Declarative, NOT an executable IR.
//
// Key invariants (implemented in P1):
// - SCHEMA_VERSION gating for back-compat
// - revision = sha256 of canonical JSON (stable key order, excluding revision itself)
// - Manifest is schema-validated, not hand-rolled
// - FieldSchema shared derive() used by both typed-graph generics and manifest serializer

export {};
