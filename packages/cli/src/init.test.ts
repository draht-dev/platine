// SPDX-License-Identifier: Apache-2.0
/**
 * init.test.ts — tests for the `platine init` command.
 *
 * Scaffolds into a real temp directory. No network, no API keys.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "./init.js";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("init", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds the expected files into a temp dir (default template)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my-agent", cwd: tmp });

    // Result shape
    expect(result.dir).toBe(join(tmp, "my-agent"));
    expect(result.files).toContain("agent.md");
    expect(result.files).toContain("workflow.ts");
    expect(result.files).toContain("tools/greet.ts");
    expect(result.files).toContain("sst.ts");

    // Files exist on disk
    expect(await exists(join(result.dir, "agent.md"))).toBe(true);
    expect(await exists(join(result.dir, "workflow.ts"))).toBe(true);
    expect(await exists(join(result.dir, "tools", "greet.ts"))).toBe(true);
    expect(await exists(join(result.dir, "sst.ts"))).toBe(true);
  });

  it("agent.md contains the agent name", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "support-triage", cwd: tmp });
    const content = await readFile(join(result.dir, "agent.md"), "utf8");

    expect(content).toContain("# support-triage");
  });

  it("workflow.ts imports from @draht/core", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my-agent", cwd: tmp });
    const content = await readFile(join(result.dir, "workflow.ts"), "utf8");

    expect(content).toContain("@draht/core/define-workflow");
    expect(content).toContain("defineWorkflow");
    expect(content).toContain("defineAgent");
  });

  it("workflow.ts exports a default export", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my-agent", cwd: tmp });
    const content = await readFile(join(result.dir, "workflow.ts"), "utf8");

    expect(content).toContain("export default defineWorkflow");
  });

  it("tools/greet.ts contains a defineTool call", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my-agent", cwd: tmp });
    const content = await readFile(join(result.dir, "tools", "greet.ts"), "utf8");

    expect(content).toContain("defineTool");
    expect(content).toContain("@draht/core/define-tool");
  });

  it("sst.ts contains draht.Agent factory call", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my-agent", cwd: tmp });
    const content = await readFile(join(result.dir, "sst.ts"), "utf8");

    expect(content).toContain("draht.Agent");
    expect(content).toContain("@draht/sst");
  });

  it("default name is 'my-agent' when name is omitted", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ cwd: tmp });

    expect(result.dir).toBe(join(tmp, "my-agent"));
    expect(await exists(result.dir)).toBe(true);
  });

  it("-t workflow template scaffolds same files as default", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "wf-agent", template: "workflow", cwd: tmp });

    expect(result.files).toContain("agent.md");
    expect(result.files).toContain("workflow.ts");
    expect(result.files).toContain("tools/greet.ts");
    expect(result.files).toContain("sst.ts");
  });

  it("throws for unknown template", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    await expect(init({ name: "x", template: "invalid", cwd: tmp })).rejects.toThrow(
      /Unknown template/
    );
  });

  it("throws if the directory already exists", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    // First init succeeds
    await init({ name: "my-agent", cwd: tmp });

    // Second init should throw
    await expect(init({ name: "my-agent", cwd: tmp })).rejects.toThrow(
      /already exists/i
    );
  });

  it("sanitises names with spaces", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-init-test-"));
    created.push(tmp);

    const result = await init({ name: "my agent", cwd: tmp });

    expect(result.dir).toBe(join(tmp, "my-agent"));
  });
});
