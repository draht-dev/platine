// SPDX-License-Identifier: Apache-2.0
/**
 * Smoke tests for @draht/manifest.
 *
 * This package is a stable re-export of @draht/core/manifest. These tests
 * verify that the re-export surface is intact and the key symbols are accessible.
 *
 * Full integration tests live in packages/core/src/manifest/manifest.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  ManifestZ,
  parseManifest,
  computeRevision,
  ManifestValidationError,
  ManifestVersionError,
  derive,
  zodToJsonSchema,
  JsonSchemaSerializationError,
  SCHEMA_VERSION,
  FieldSchemaZ,
} from "./index.js";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Re-export surface smoke tests
// ---------------------------------------------------------------------------

describe("@draht/manifest re-export surface", () => {
  it("exports ManifestZ", () => {
    expect(ManifestZ).toBeDefined();
  });

  it("exports parseManifest as a function", () => {
    expect(typeof parseManifest).toBe("function");
  });

  it("exports computeRevision as a function", () => {
    expect(typeof computeRevision).toBe("function");
  });

  it("exports ManifestValidationError class", () => {
    const err = new ManifestValidationError("test");
    expect(err).toBeInstanceOf(ManifestValidationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ManifestValidationError");
  });

  it("exports ManifestVersionError class", () => {
    const err = new ManifestVersionError("test");
    expect(err).toBeInstanceOf(ManifestVersionError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ManifestVersionError");
  });

  it("exports derive as a function", () => {
    expect(typeof derive).toBe("function");
  });

  it("exports zodToJsonSchema as a function", () => {
    expect(typeof zodToJsonSchema).toBe("function");
  });

  it("exports JsonSchemaSerializationError class", () => {
    const err = new JsonSchemaSerializationError("test");
    expect(err).toBeInstanceOf(JsonSchemaSerializationError);
    expect(err).toBeInstanceOf(Error);
  });

  it("exports SCHEMA_VERSION as '1.0.0'", () => {
    expect(SCHEMA_VERSION).toBe("1.0.0");
  });

  it("exports FieldSchemaZ", () => {
    expect(FieldSchemaZ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Integration smoke: parseManifest via the re-export chain
// ---------------------------------------------------------------------------

describe("parseManifest via @draht/manifest re-export", () => {
  const minimalManifest = {
    schemaVersion: "1.0.0",
    revision: "rev_test",
    kind: "agent",
    agent: {
      agentId: "test-agent",
      name: "Test Agent",
      model: { provider: "anthropic", modelId: "claude-3-5-sonnet-20241022" },
      instructionsRef: { contentHash: "sha256:abc123" },
    },
    tenancy: { mode: "single" },
    resources: {
      needsEventBus: true,
    },
    resume: { via: "api", holdsApproval: false },
  };

  it("parses a minimal valid manifest", () => {
    const manifest = parseManifest(minimalManifest);
    expect(manifest.agent.agentId).toBe("test-agent");
    expect(manifest.schemaVersion).toBe("1.0.0");
  });

  it("throws ManifestVersionError for schemaVersion 2.0.0", () => {
    const raw: unknown = { ...minimalManifest, schemaVersion: "2.0.0" };
    expect(() => parseManifest(raw)).toThrow(ManifestVersionError);
  });

  it("throws ManifestValidationError for missing required fields", () => {
    expect(() => parseManifest({ schemaVersion: "1.0.0" })).toThrow(
      ManifestValidationError
    );
  });
});

// ---------------------------------------------------------------------------
// Integration smoke: derive() via the re-export chain
// ---------------------------------------------------------------------------

describe("derive() via @draht/manifest re-export", () => {
  it("derives fields from a z.object schema", () => {
    const schema = z.object({ id: z.string(), count: z.number() });
    const fields = derive(schema);
    expect(fields).toHaveLength(2);
    const idField = fields.find((f) => f.path === "id");
    expect(idField?.type).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Integration smoke: computeRevision via the re-export chain
// ---------------------------------------------------------------------------

describe("computeRevision via @draht/manifest re-export", () => {
  it("produces a stable sha256 hex revision", () => {
    const rev = computeRevision({ schemaVersion: "1.0.0", kind: "agent" });
    expect(rev).toMatch(/^[0-9a-f]{64}$/);
  });

  it("excludes the revision field", () => {
    const r1 = computeRevision({ kind: "agent", revision: "old" });
    const r2 = computeRevision({ kind: "agent", revision: "new" });
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Integration smoke: zodToJsonSchema via the re-export chain
// ---------------------------------------------------------------------------

describe("zodToJsonSchema via @draht/manifest re-export", () => {
  it("serializes a z.object to JSON Schema", () => {
    const schema = z.object({ name: z.string(), count: z.number() });
    const jsonSchema = zodToJsonSchema(schema);
    expect(jsonSchema["type"]).toBe("object");
    const props = jsonSchema["properties"] as Record<string, unknown>;
    expect(props["name"]).toMatchObject({ type: "string" });
  });

  it("throws JsonSchemaSerializationError for recursive schemas", () => {
    const Recursive: z.ZodType<unknown> = z.lazy(() =>
      z.object({ name: z.string(), child: Recursive.optional() })
    );
    expect(() => zodToJsonSchema(Recursive)).toThrow(
      JsonSchemaSerializationError
    );
  });
});
