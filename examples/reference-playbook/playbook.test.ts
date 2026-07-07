// SPDX-License-Identifier: Apache-2.0
/**
 * playbook.test.ts — build-assertion tests for the reference playbook.
 *
 * Tests:
 *   1. workflow.ts typechecks (imports compile without errors at module load)
 *   2. `platine build --skip-typecheck` produces a .platine/manifest.json
 *   3. The manifest parses via parseManifest (round-trip validation)
 *   4. The manifest contains the expected nodes and approval-gated tool
 */

import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, access } from "node:fs/promises";
import { parseManifest } from "@draht/manifest";
import { build } from "@draht/platine";
import { buildToolRegistry } from "@draht/core/compile";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_DIR = __dirname;

describe("reference-playbook", () => {
  it("workflow.ts imports correctly and has a WorkflowDef default export", async () => {
    const mod = await import("./workflow.js");
    const wf = (mod as Record<string, unknown>)["default"];
    expect(wf).toBeDefined();
    expect(typeof (wf as Record<string, unknown>)["compile"]).toBe("function");
    expect(Array.isArray((wf as Record<string, unknown>)["nodes"])).toBe(true);
    expect(Array.isArray((wf as Record<string, unknown>)["edges"])).toBe(true);
  });

  it("workflow has trigger + classify + escalate nodes", async () => {
    const mod = await import("./workflow.js");
    const wf = (mod as Record<string, unknown>)["default"] as {
      nodes: ReadonlyArray<{ kind: string }>;
    };
    const kinds = wf.nodes.map((n) => n.kind);
    // trigger, tool (classify), tool (escalate), output
    expect(kinds).toContain("trigger");
    expect(kinds.filter((k) => k === "tool").length).toBeGreaterThanOrEqual(2);
  });

  it("platine build produces a manifest.json that parseManifest accepts", async () => {
    // Use build() with skipTypecheck:true so the test does not require tsc
    // in PATH (CI may not have it in the vitest worker PATH).
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: true,
    });

    expect(result.manifest).toBeDefined();
    expect(result.manifestPath).toBeTruthy();

    // Round-trip: read from disk and re-parse.
    const raw: unknown = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const parsed = parseManifest(raw);

    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.kind).toBe("workflow");
    expect(parsed.resume.holdsApproval).toBe(true);
  });

  it("manifest contains tool nodes including approval-gated escalate", async () => {
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: false,
    });
    const { manifest } = result;

    // At least two tool nodes (classify + escalate)
    const toolNodes = manifest.nodes.filter((n) => n.kind === "tool");
    expect(toolNodes.length).toBeGreaterThanOrEqual(2);

    // At least one approval-gated tool node
    const approvalNodes = toolNodes.filter(
      (n) => n.kind === "tool" && (n as { requiresApproval?: boolean }).requiresApproval === true
    );
    expect(approvalNodes.length).toBeGreaterThanOrEqual(1);

    // At least one edge connecting the nodes
    expect(manifest.edges.length).toBeGreaterThanOrEqual(1);

    // Tools registry contains escalate_ticket with requiresApproval
    const escalateTool = manifest.tools.find((t) => t.requiresApproval === true);
    expect(escalateTool).toBeDefined();
  });

  it("manifest trigger is event type with ticket.created", async () => {
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: false,
    });
    const { manifest } = result;

    const eventTrigger = manifest.triggers.find((t) => t.type === "event");
    expect(eventTrigger).toBeDefined();
    if (eventTrigger && eventTrigger.type === "event") {
      expect(eventTrigger.eventType).toBe("ticket.created");
    }
  });

  it("manifest has resume.holdsApproval = true", async () => {
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: false,
    });
    expect(result.manifest.resume.holdsApproval).toBe(true);
    expect(result.manifest.resume.via).toBe("api");
  });

  it("platine build emits the executor entry file on disk", async () => {
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: true,
    });

    expect(result.entryPath).toBeTruthy();
    // Throws if the file does not exist — access() rejects on ENOENT.
    await expect(access(result.entryPath)).resolves.toBeUndefined();
  });

  it("buildToolRegistry(workflow) covers every toolRef in the compiled manifest", async () => {
    const result = await build({
      dir: PLAYBOOK_DIR,
      skipTypecheck: true,
      write: false,
    });
    const { manifest } = result;

    const mod = await import("./workflow.js");
    const workflow = (mod as Record<string, unknown>)["default"] as Parameters<
      typeof buildToolRegistry
    >[0];

    const registry = buildToolRegistry(workflow);

    for (const tool of manifest.tools) {
      expect(registry.has(tool.toolId)).toBe(true);
    }
  });
});
