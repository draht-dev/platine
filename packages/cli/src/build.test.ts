// SPDX-License-Identifier: Apache-2.0
/**
 * build.test.ts — tests for the `platine build` command.
 *
 * Uses skipTypecheck:true so we don't need a tsconfig in the temp dir.
 * We write a minimal workflow.ts using the source-aliased @draht/core imports
 * (vitest.config.ts resolves them) and verify that:
 *   1. build() produces a manifest.json that parseManifest accepts.
 *   2. The manifest round-trips correctly.
 *
 * No network, no API keys.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@draht/manifest";
import { build } from "./build.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a minimal workflow.ts that exports a WorkflowDef-compatible object
 * with a hard-coded compile() returning a valid manifest.
 *
 * build() loads workflow.ts via pathToFileURL + dynamic import in a fresh
 * subprocess context. We write plain-JS-compatible syntax (no type annotations)
 * so that Node's ESM loader can import the file directly without tsc/tsx.
 *
 * build() is called with skipTypecheck:true so no tsconfig is needed.
 */
async function writeMinimalWorkflow(dir: string): Promise<void> {
  // Write a minimal workflow.ts that exports a WorkflowDef-compatible object
  // with a hard-coded compile() method. This avoids needing @draht/core to be
  // importable in the subprocess (no tsc/tsx, plain Node ESM import).
  const hardCodedWorkflow = [
    "export default {",
    "  nodes: [],",
    "  edges: [],",
    "  outputNodeId: 'trigger_1',",
    "  compile() {",
    "    return {",
    "      schemaVersion: '1.0.0',",
    "      revision: 'rev_test_build',",
    "      kind: 'workflow',",
    "      agent: {",
    "        agentId: 'test-build-agent',",
    "        name: 'Test Build Agent',",
    "        model: { provider: 'anthropic', modelId: 'anthropic/claude-haiku-4-5' },",
    "        instructionsRef: { contentHash: 'sha256:abc123', inline: 'Test agent' },",
    "        skills: [],",
    "        maxIterations: 5,",
    "        maxToolCallsPerIteration: 3,",
    "        circuitBreakerErrorThreshold: 5,",
    "      },",
    "      tenancy: { mode: 'single' },",
    "      triggers: [{ type: 'manual' }],",
    "      channels: [],",
    "      connections: [],",
    "      tools: [],",
    "      nodes: [],",
    "      edges: [],",
    "      resources: {",
    "        needsHttpEgress: false,",
    "        needsBedrock: false,",
    "        needsEventBus: true,",
    "        secrets: [],",
    "        extraIam: [],",
    "      },",
    "      resume: { via: 'api', holdsApproval: false },",
    "    };",
    "  },",
    "};",
  ].join("\n") + "\n";

  await writeFile(join(dir, "workflow.ts"), hardCodedWorkflow, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("build", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("produces a manifest.json that parseManifest accepts (round-trip)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const result = await build({
      dir: tmp,
      skipTypecheck: true, // no tsconfig in temp dir
    });

    // manifest.json exists
    expect(await exists(result.manifestPath)).toBe(true);

    // round-trip: re-parse the file
    const raw = JSON.parse(await readFile(result.manifestPath, "utf8")) as unknown;
    const parsed = parseManifest(raw);

    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.agent.agentId).toBe("test-build-agent");
    expect(parsed.kind).toBe("workflow");
  });

  it("manifest.json is valid JSON and passes parseManifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const { manifest, manifestPath } = await build({
      dir: tmp,
      skipTypecheck: true,
    });

    // File is valid JSON
    const fileContent = await readFile(manifestPath, "utf8");
    expect(() => JSON.parse(fileContent)).not.toThrow();

    // In-memory manifest matches file
    const fromFile = JSON.parse(fileContent) as unknown;
    const reparsed = parseManifest(fromFile);
    expect(reparsed.revision).toBe(manifest.revision);
  });

  it("writes .platine/manifest.json inside the agent dir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const result = await build({ dir: tmp, skipTypecheck: true });

    expect(result.manifestPath).toMatch(/\.platine[/\\]manifest\.json$/);
    expect(result.manifestPath.startsWith(tmp)).toBe(true);
  });

  it("write:false returns manifest without writing to disk", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const result = await build({ dir: tmp, skipTypecheck: true, write: false });

    expect(result.manifestPath).toBe("");
    // .platine/manifest.json should NOT exist
    expect(await exists(join(tmp, ".platine", "manifest.json"))).toBe(false);
    // Manifest is still returned
    expect(result.manifest.schemaVersion).toBe("1.0.0");
  });

  it("writes .platine/executor.entry.ts that imports ../workflow.js + exports handler", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const result = await build({ dir: tmp, skipTypecheck: true });

    expect(result.entryPath).toMatch(/\.platine[/\\]executor\.entry\.ts$/);
    expect(await exists(result.entryPath)).toBe(true);

    const source = await readFile(result.entryPath, "utf8");
    expect(source).toContain('import workflow from "../workflow.js"');
    expect(source).toContain('import { makeExecutorHandler } from "@draht/runtime-aws"');
    expect(source).toContain("export const handler = makeExecutorHandler({ workflow });");
  });

  it("write:false skips writing .platine/executor.entry.ts", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    const result = await build({ dir: tmp, skipTypecheck: true, write: false });

    expect(result.entryPath).toBe("");
    expect(await exists(join(tmp, ".platine", "executor.entry.ts"))).toBe(false);
  });

  it("throws if workflow.ts has no default export", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    // Write a workflow.ts with no default export
    await writeFile(join(tmp, "workflow.ts"), "export const foo = 1;\n", "utf8");

    await expect(build({ dir: tmp, skipTypecheck: true })).rejects.toThrow(
      /default export/i
    );
  });

  it("throws if default export has no compile() method", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeFile(join(tmp, "workflow.ts"), "export default { nodes: [] };\n", "utf8");

    await expect(build({ dir: tmp, skipTypecheck: true })).rejects.toThrow(
      /compile/i
    );
  });

  it("creates the .platine directory if it does not exist", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-test-"));
    created.push(tmp);

    await writeMinimalWorkflow(tmp);

    // Ensure .platine does NOT pre-exist
    expect(await exists(join(tmp, ".platine"))).toBe(false);

    await build({ dir: tmp, skipTypecheck: true });

    expect(await exists(join(tmp, ".platine"))).toBe(true);
  });
});

describe("build — real DSL fixture (tsx load, end-to-end)", () => {
  // The fixture is a genuine agent dir: workflow.ts uses defineWorkflow + a
  // defineTool imported via a NodeNext './tools/greet.js' specifier + zod/v4.
  // This is the exact shape that broke before the tsx-loading fix
  // ("Cannot find module './tools/greet.js'"). write:false keeps the fixture
  // dir clean while exercising the REAL compile path (no hard-coded manifest).
  const fixtureDir = join(import.meta.dirname, "__fixtures__", "real-agent");

  it("loads a real TS workflow via tsx and compiles a manifest parseManifest accepts", async () => {
    const result = await build({ dir: fixtureDir, skipTypecheck: true, write: false });

    const parsed = parseManifest(result.manifest);
    expect(parsed.agent.agentId).toBe("fixture-greet-agent");
    expect(parsed.kind).toBe("workflow");
    // The greet tool node must be present (real compilation of the DSL graph).
    expect(parsed.nodes.length).toBeGreaterThan(0);
    expect(parsed.tools.some((t) => /greet/i.test(t.description))).toBe(true);
  });
});

describe("build — init-scaffolded workflow", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds a workflow scaffolded by init (skipTypecheck:true)", async () => {
    const { init } = await import("./init.js");
    const tmp = await mkdtemp(join(tmpdir(), "platine-build-init-test-"));
    created.push(tmp);

    // Scaffold the agent directory
    const initResult = await init({ name: "test-agent", cwd: tmp });
    const agentDir = initResult.dir;

    // Replace workflow.ts with a simple stub that doesn't need @draht/core resolution
    await writeFile(
      join(agentDir, "workflow.ts"),
      `export default {
  nodes: [],
  edges: [],
  outputNodeId: "t1",
  compile() {
    return {
      schemaVersion: "1.0.0",
      revision: "rev_init_test",
      kind: "workflow",
      agent: {
        agentId: "test-agent",
        name: "Test Agent",
        model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        instructionsRef: { contentHash: "sha256:000", inline: "Test" },
        skills: [],
        maxIterations: 5,
        maxToolCallsPerIteration: 3,
        circuitBreakerErrorThreshold: 5,
      },
      tenancy: { mode: "single" },
      triggers: [{ type: "manual" }],
      channels: [],
      connections: [],
      tools: [],
      nodes: [],
      edges: [],
      resources: {
        needsHttpEgress: false,
        needsBedrock: false,
        needsEventBus: true,
        secrets: [],
        extraIam: [],
      },
      resume: { via: "api", holdsApproval: false },
    };
  },
};
`,
      "utf8"
    );

    const result = await build({ dir: agentDir, skipTypecheck: true });

    // round-trip
    const raw = JSON.parse(await readFile(result.manifestPath, "utf8")) as unknown;
    const parsed = parseManifest(raw);

    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.agent.agentId).toBe("test-agent");
  });
});
