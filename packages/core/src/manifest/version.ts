// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest/version — Schema version constant and major-version compatibility helper.
 *
 * The runtime gates back-compat by comparing the manifest's schemaVersion major to
 * the current SCHEMA_VERSION major. A major mismatch means the runtime cannot safely
 * execute the manifest (breaking changes in the schema structure).
 */

export const SCHEMA_VERSION = "1.0.0" as const;

/**
 * Returns true if `candidateVersion` is compatible with the current SCHEMA_VERSION.
 *
 * Compatibility is defined as: same major version number.
 * e.g. "1.0.0" is compatible with "1.2.3" but NOT with "2.0.0".
 */
export function isCompatibleVersion(candidateVersion: string): boolean {
  const candidateMajor = candidateVersion.split(".")[0];
  const runtimeMajor = SCHEMA_VERSION.split(".")[0];
  return candidateMajor === runtimeMajor;
}
