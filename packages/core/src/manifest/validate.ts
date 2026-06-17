// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest/validate — Manifest parsing, validation, and revision hashing.
 *
 * - parseManifest: validates raw unknown input against ManifestZ; throws typed errors.
 * - computeRevision: sha256 of canonical JSON (stable key order, excluding `revision`).
 * - ManifestValidationError: schema validation failed (bad structure / missing fields).
 * - ManifestVersionError: schemaVersion major mismatch — runtime cannot handle this manifest.
 */

import { createHash } from "node:crypto";
import { ManifestZ } from "./schema.js";
import type { Manifest } from "./schema.js";
import { SCHEMA_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * Thrown by parseManifest when the raw input does not conform to ManifestZ.
 * The message contains the zod error description.
 */
export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

/**
 * Thrown by parseManifest when the manifest's schemaVersion major does not match
 * the current runtime SCHEMA_VERSION major. The runtime cannot safely execute
 * a manifest whose major version differs from the one it was compiled against.
 */
export class ManifestVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestVersionError";
  }
}

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw unknown value as a Manifest.
 *
 * Order of checks:
 * 1. Extract schemaVersion from the raw input (if present) and check major-version
 *    compatibility → throws ManifestVersionError if the major version differs from
 *    the runtime's SCHEMA_VERSION major. This check happens BEFORE full schema validation
 *    so that "wrong version" is always a ManifestVersionError, not a ManifestValidationError.
 * 2. Full Zod schema validation — throws ManifestValidationError on any structural failure.
 *
 * Returns the strongly-typed, default-filled Manifest on success.
 */
export function parseManifest(raw: unknown): Manifest {
  // Step 1: Early major-version check so wrong-version manifests throw ManifestVersionError.
  // We peek at schemaVersion before running the full parse.
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const maybeSemver = (raw as Record<string, unknown>)["schemaVersion"];
    if (typeof maybeSemver === "string" && maybeSemver.length > 0) {
      const parsedMajor = maybeSemver.split(".")[0];
      const runtimeMajor = SCHEMA_VERSION.split(".")[0];
      if (parsedMajor !== runtimeMajor) {
        throw new ManifestVersionError(
          `schemaVersion ${maybeSemver} != runtime ${SCHEMA_VERSION}`
        );
      }
    }
  }

  // Step 2: Full structural validation.
  const result = ManifestZ.safeParse(raw);
  if (!result.success) {
    throw new ManifestValidationError(result.error.message);
  }

  return result.data;
}

// ---------------------------------------------------------------------------
// computeRevision
// ---------------------------------------------------------------------------

/**
 * Recursively sort an object's keys to produce a canonical representation.
 * Arrays preserve their order; object keys are sorted lexicographically.
 * The `revision` key is excluded from the top-level object.
 */
function canonicalize(value: unknown, isRoot = false): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, false));
  }
  // Plain object — sort keys, exclude `revision` at root
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    if (isRoot && key === "revision") continue;
    const val = obj[key];
    result[key] = canonicalize(val, false);
  }
  return result;
}

/**
 * Compute the revision hash for a manifest body.
 *
 * The revision is the lowercase hex sha256 of the canonical JSON representation
 * of the manifest body, where:
 * - Object keys are recursively sorted lexicographically.
 * - The `revision` field itself is excluded from the top-level object.
 * - Arrays preserve element order.
 *
 * This means re-ordering keys in the source JSON produces the same revision,
 * but changing any value produces a different revision.
 */
export function computeRevision(body: unknown): string {
  const canonical = canonicalize(body, true);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json, "utf8").digest("hex");
}
