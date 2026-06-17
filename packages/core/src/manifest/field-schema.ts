// SPDX-License-Identifier: Apache-2.0
/**
 * @draht/core/manifest/field-schema — derive() function for FieldSchema trees.
 *
 * THE single cross-track contract: both P2's typed-graph generics and the node
 * outputSchema serializer call this exact function. Any change here propagates
 * to both consumers.
 *
 * ## Behaviour
 *
 * derive(zodSchema) walks a Zod object/array and produces a flat-ish tree where
 * each node has:
 *   - `path`:          dotted key path from the root (e.g. "ticket.id")
 *   - `type`:          one of string|number|boolean|object|array|unknown
 *   - `isTemplatable`: false for ANY path containing '[]' (array-element marker)
 *   - `fields?`:       child FieldSchema[] for object nodes
 *   - `items?`:        single FieldSchema for array nodes (the element schema)
 *
 * ## Rules
 *
 * - z.object            → recurse into each key; produces "object" leaf with `fields`
 * - z.array             → descend with '[]' appended to path; produces "array" leaf with `items`
 * - z.string            → "string" leaf
 * - z.number            → "number" leaf
 * - z.boolean           → "boolean" leaf
 * - z.enum              → "string" leaf (enum values are all strings at runtime)
 * - z.literal           → mapped to string|number|boolean based on value type, else "unknown"
 * - z.optional          → unwrap, recurse
 * - z.nullable          → unwrap, recurse
 * - z.default           → unwrap, recurse
 * - z.union / z.discriminatedUnion → best-effort: use the first option's shape for the path
 *   tree. Rationale: the manifest's FieldSchema is used for template-variable completion;
 *   emitting the first option gives reasonable autocomplete for the common case. A comment
 *   in the output is not possible, so this choice is documented here only.
 * - z.intersection (.and()) → merge the shapes of left and right (best-effort)
 * - everything else     → "unknown" leaf (no further descent)
 *
 * ## Design
 *
 * Pure, total, no side-effects. Does not throw (unknown constructs produce "unknown" leaves).
 */

import { z } from "zod/v4";
import type { FieldSchema } from "./schema.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Result of classifying a zod schema node. */
type Classification =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "object"; shape: Record<string, z.ZodTypeAny> }
  | { kind: "array"; element: z.ZodTypeAny }
  | { kind: "union"; options: z.ZodTypeAny[] }
  | { kind: "intersection"; left: z.ZodTypeAny; right: z.ZodTypeAny }
  | { kind: "unknown" };

// ---------------------------------------------------------------------------
// classify: reduce a ZodType to its essential shape
// ---------------------------------------------------------------------------

/**
 * Classify a ZodType into one of the canonical shape kinds.
 * Transparent wrappers (optional, nullable, default, lazy) are unwrapped.
 */
function classify(schema: z.ZodTypeAny): Classification {
  const def = schema._zod.def as { type: string; [key: string]: unknown };

  switch (def.type) {
    case "string":
      return { kind: "string" };
    case "number":
    case "int":
    case "float":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      // enum values are always strings in zod; treat as string leaf
      return { kind: "string" };
    case "literal": {
      // literal value can be string | number | boolean; map accordingly
      const values = def["values"] as unknown[];
      const firstVal = values[0];
      if (typeof firstVal === "string") return { kind: "string" };
      if (typeof firstVal === "number") return { kind: "number" };
      if (typeof firstVal === "boolean") return { kind: "boolean" };
      return { kind: "unknown" };
    }
    case "object": {
      const shape = def["shape"] as Record<string, z.ZodTypeAny>;
      return { kind: "object", shape };
    }
    case "array": {
      const element = def["element"] as z.ZodTypeAny;
      return { kind: "array", element };
    }
    case "optional":
    case "nullable":
    case "default": {
      const inner = def["innerType"] as z.ZodTypeAny;
      return classify(inner);
    }
    case "lazy": {
      const getter = def["getter"] as () => z.ZodTypeAny;
      return classify(getter());
    }
    case "union": {
      const options = def["options"] as z.ZodTypeAny[];
      return { kind: "union", options };
    }
    case "intersection": {
      const left = def["left"] as z.ZodTypeAny;
      const right = def["right"] as z.ZodTypeAny;
      return { kind: "intersection", left, right };
    }
    default:
      return { kind: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// mergeShapes: merge two object shapes (for intersection / .and())
// ---------------------------------------------------------------------------

/**
 * Merge two object shape records. Right-side values win on key collision.
 * Non-object classifications are ignored gracefully.
 */
function mergeShapes(
  left: z.ZodTypeAny,
  right: z.ZodTypeAny
): Record<string, z.ZodTypeAny> {
  const leftC = classify(left);
  const rightC = classify(right);
  const leftShape: Record<string, z.ZodTypeAny> =
    leftC.kind === "object" ? leftC.shape : {};
  const rightShape: Record<string, z.ZodTypeAny> =
    rightC.kind === "object" ? rightC.shape : {};
  return { ...leftShape, ...rightShape };
}

// ---------------------------------------------------------------------------
// deriveNode: core recursive worker
// ---------------------------------------------------------------------------

/**
 * Derive a single FieldSchema node for the given zod schema at `path`.
 *
 * @param schema         The zod schema to walk.
 * @param path           The dotted path for this node (e.g. "ticket.id").
 * @param isTemplatable  False if any ancestor segment contained '[]'.
 */
function deriveNode(
  schema: z.ZodTypeAny,
  path: string,
  isTemplatable: boolean
): FieldSchema {
  const c = classify(schema);

  switch (c.kind) {
    case "string":
      return { path, type: "string", isTemplatable };
    case "number":
      return { path, type: "number", isTemplatable };
    case "boolean":
      return { path, type: "boolean", isTemplatable };

    case "object": {
      const fields = Object.entries(c.shape).map(([key, childSchema]) => {
        const childPath = path === "" ? key : `${path}.${key}`;
        return deriveNode(childSchema, childPath, isTemplatable);
      });
      return { path, type: "object", isTemplatable, fields };
    }

    case "array": {
      // Array-element descent: append '[]' and mark non-templatable for all descendants
      const itemPath = path === "" ? "[]" : `${path}[]`;
      const itemNode = deriveNode(c.element, itemPath, false);
      return { path, type: "array", isTemplatable, items: itemNode };
    }

    case "union": {
      // Best-effort: use the first option's classification.
      // Discriminated unions and plain unions are both covered here since both
      // produce kind === "union" from the classifier.
      const firstOption = c.options[0];
      if (firstOption === undefined) {
        return { path, type: "unknown", isTemplatable };
      }
      return deriveNode(firstOption, path, isTemplatable);
    }

    case "intersection": {
      // Merge the shapes of both sides; produce an object node.
      const merged = mergeShapes(c.left, c.right);
      const fields = Object.entries(merged).map(([key, childSchema]) => {
        const childPath = path === "" ? key : `${path}.${key}`;
        return deriveNode(childSchema, childPath, isTemplatable);
      });
      return { path, type: "object", isTemplatable, fields };
    }

    case "unknown":
      return { path, type: "unknown", isTemplatable };
  }
}

// ---------------------------------------------------------------------------
// derive — public API
// ---------------------------------------------------------------------------

/**
 * Walk a Zod schema and produce the full FieldSchema tree.
 *
 * When called on a z.object, each top-level key becomes a root FieldSchema
 * with the key as its path. When called on any other schema type (including
 * z.array or primitives), a single FieldSchema is returned at path "".
 *
 * Returns an array of root-level FieldSchema nodes. For z.object schemas this
 * is one entry per key. For other types this is typically a single entry.
 *
 * @example
 * const schema = z.object({ ticket: z.object({ id: z.string(), count: z.number() }) });
 * derive(schema);
 * // → [{ path: "ticket", type: "object", isTemplatable: true, fields: [
 * //      { path: "ticket.id", type: "string", isTemplatable: true },
 * //      { path: "ticket.count", type: "number", isTemplatable: true },
 * //   ] }]
 *
 * @example Array of objects
 * const schema = z.object({ items: z.array(z.object({ name: z.string() })) });
 * derive(schema);
 * // → [{ path: "items", type: "array", isTemplatable: true, items: {
 * //      path: "items[]", type: "object", isTemplatable: false, fields: [
 * //        { path: "items[].name", type: "string", isTemplatable: false }
 * //      ]
 * //    } }]
 */
export function derive(zodSchema: z.ZodTypeAny): FieldSchema[] {
  const c = classify(zodSchema);

  if (c.kind === "object") {
    // For object schemas, emit one FieldSchema per top-level key
    return Object.entries(c.shape).map(([key, childSchema]) =>
      deriveNode(childSchema, key, true)
    );
  }

  if (c.kind === "intersection") {
    // Merge both sides and emit one FieldSchema per merged key
    const merged = mergeShapes(c.left, c.right);
    return Object.entries(merged).map(([key, childSchema]) =>
      deriveNode(childSchema, key, true)
    );
  }

  // Non-object root: wrap in a single entry at path ""
  return [deriveNode(zodSchema, "", true)];
}
