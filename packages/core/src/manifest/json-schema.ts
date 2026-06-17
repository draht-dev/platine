// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest/json-schema — JSON-Schema serializer helper.
 *
 * Converts a Zod inputSchema to a plain JSON-Schema-compatible object using
 * the zod v4 `toJSONSchema` function (z.toJSONSchema).
 *
 * ## Usage
 *
 * Used to serialize tool inputSchema when building the Manifest. The serialized
 * form is stored in ToolRefZ.inputSchema.
 *
 * ## Failure behaviour
 *
 * Throws `JsonSchemaSerializationError` for:
 * - Schemas that produce `$ref` cycles (recursive schemas): the tool inputSchema
 *   must be a flat JSON-Schema object; recursive definitions are not valid in this
 *   context and indicate a programming error in the tool definition.
 * - Any other serialization failure reported by zod's toJSONSchema.
 *
 * ## Note on the zod codepath
 *
 * We import from "zod/v4" (not "zod") because `toJSONSchema` lives on the v4
 * codepath. The root "zod" entry still exports the v3 API which lacks this method.
 */

import { toJSONSchema } from "zod/v4";
import type { z } from "zod/v4";

// Re-export the JSON-Schema type for consumers
export type { JSONSchema } from "zod/v4/core";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when a Zod schema cannot be serialized to a flat JSON-Schema object.
 *
 * Common causes:
 * - Recursive schemas (z.lazy self-references) — produce $ref cycles
 * - Non-JSON-Schema-expressible constructs (transforms, branded types, etc.)
 */
export class JsonSchemaSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonSchemaSerializationError";
  }
}

// ---------------------------------------------------------------------------
// Serialized JSON-Schema shape expected by ToolRefZ.inputSchema
// ---------------------------------------------------------------------------

/** The JSON-Schema subset stored in ToolRefZ.inputSchema. */
export type ToolInputJsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

// ---------------------------------------------------------------------------
// zodToJsonSchema — main helper
// ---------------------------------------------------------------------------

/**
 * Serialize a Zod object schema to the JSON-Schema subset used by ToolRefZ.inputSchema.
 *
 * @param schema A z.ZodTypeAny — should be a z.object schema for tool inputs.
 * @returns      A JSON-Schema-compatible plain object.
 * @throws       JsonSchemaSerializationError if serialization fails or the result
 *               contains unsupported constructs like recursive $ref.
 *
 * @example
 * const inputSchema = z.object({ ticketId: z.string(), reason: z.string() });
 * const jsonSchema = zodToJsonSchema(inputSchema);
 * // { type: "object", properties: { ticketId: { type: "string" }, reason: { type: "string" } }, required: ["ticketId","reason"] }
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  let result: Record<string, unknown>;

  try {
    // Use "throw" for unrepresentable types — fail loud, never silently emit {}
    const raw = toJSONSchema(schema, { unrepresentable: "throw" });
    result = raw as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JsonSchemaSerializationError(
      `Failed to serialize Zod schema to JSON Schema: ${msg}`
    );
  }

  // Detect recursive $ref in $defs — not supported for tool inputSchema
  if (hasCyclicRef(result)) {
    throw new JsonSchemaSerializationError(
      "Zod schema contains recursive $ref — recursive schemas are not supported for tool inputSchema. " +
        "Use a flat, non-recursive schema."
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal: detect recursive $ref
// ---------------------------------------------------------------------------

/**
 * Returns true if the JSON-Schema object contains any $ref that points back
 * to a root-level $defs entry (i.e., a self-referencing or recursive schema).
 *
 * A plain `$ref: "#"` (self-ref to root) is always considered cyclic.
 * A `$ref: "#/$defs/..."` is checked against whether $defs contains that entry.
 */
function hasCyclicRef(schema: Record<string, unknown>): boolean {
  if (typeof schema.$ref === "string") {
    // Self-reference to root
    if (schema.$ref === "#") return true;
    // Reference into $defs — check if the definition itself refers back
    const defs = schema.$defs;
    if (defs !== null && typeof defs === "object") {
      return containsRef(defs as Record<string, unknown>);
    }
  }
  // Scan for any nested $ref values that indicate recursion
  return containsRef(schema);
}

function containsRef(obj: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(obj)) {
    if (key === "$ref" && typeof value === "string") {
      return true;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (containsRef(value as Record<string, unknown>)) return true;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== null && typeof item === "object") {
          if (containsRef(item as Record<string, unknown>)) return true;
        }
      }
    }
  }
  return false;
}
