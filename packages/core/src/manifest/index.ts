// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest — public surface for the Manifest sub-package.
 *
 * Both the SST component (Pulumi-program time) and the Runtime (execution time)
 * import from this subpath. Neither hand-rolls a Manifest type.
 *
 * Exports:
 *   - ManifestZ, Manifest type, FieldSchema type, and all sub-schemas
 *   - SCHEMA_VERSION, isCompatibleVersion
 *   - parseManifest, computeRevision
 *   - ManifestValidationError, ManifestVersionError
 *   - derive (FieldSchema derivation from zod schemas)
 *   - zodToJsonSchema, JsonSchemaSerializationError (JSON-Schema serializer)
 */

// Schema definitions and types
export {
  SCHEMA_VERSION,
  ManifestZ,
  FieldSchemaZ,
  EventFilterZ,
  TriggerZ,
  ToolRefZ,
  NodeZ,
  EdgeZ,
  SecretRefZ,
} from "./schema.js";
export type { Manifest, FieldSchema } from "./schema.js";

// Version compatibility helper (also re-exports SCHEMA_VERSION, but schema.ts owns the canonical one)
export { isCompatibleVersion } from "./version.js";

// Validation and revision hashing
export {
  parseManifest,
  computeRevision,
  ManifestValidationError,
  ManifestVersionError,
} from "./validate.js";

// FieldSchema derivation — THE cross-track contract
export { derive } from "./field-schema.js";

// JSON-Schema serializer helper
export {
  zodToJsonSchema,
  JsonSchemaSerializationError,
} from "./json-schema.js";
export type { ToolInputJsonSchema } from "./json-schema.js";
