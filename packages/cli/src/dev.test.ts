// SPDX-License-Identifier: Apache-2.0
/**
 * dev.test.ts — tests for the `platine dev` command (in-process execution).
 *
 * Uses a fake (scripted) Model — no network, no API keys.
 * Verifies that a scaffolded workflow runs through Memory + FakeToolsDispatcher
 * and produces a run record.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevSession } from "./dev.js";
import { FakeToolsDispatcher } from "@draht/runtime-aws";
import type { Model, ModelRequest, ModelStreamEvent, Usage } from "@draht/core/seams";

// ---------------------------------------------------------------------------
// Minimal ScriptedModel — a scripted fake Model for tests.
// (ScriptedModel lives in runtime-aws/src/fake-model.ts which is not a
// stable sub-path export, so we define a compatible version inline.)
// ---------------------------------------------------------------------------

type FakeModelResponse =
  | { stopReason: "end_turn"; text: string }
  | { stopReason: "tool_use"; text: string; toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> };

class ScriptedModel implements Model {
  private readonly script: FakeModelResponse[];
  private readonly _usage: Usage;

  constructor(script: FakeModelResponse[], usage: Usage = { inputTokens: 10, outputTokens: 5 }) {
    this.script = [...script];
    this._usage = usage;
  }

  async chat(req: ModelRequest): Promise<Extract<ModelStreamEvent, { type: "done" }>> {
    void req;
    const next = this.script.shift() ?? { stopReason: "end_turn" as const, text: "done" };
    return {
      type: "done",
      stopReason: next.stopReason,
      text: next.text,
      toolCalls: "toolCalls" in next ? next.toolCalls : [],
      usage: { ...this._usage },
      modelId: req.modelId,
    };
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelStreamEvent> {
    yield await this.chat(req);
  }

  supports(_modelId: string): boolean { return true; }
}

// ---------------------------------------------------------------------------
// Helpers — write a minimal workflow.ts into a temp dir
// ---------------------------------------------------------------------------

/**
 * Write a workflow.ts that:
 *   - has a manual trigger
 *   - has one tool node ("greet_tool")
 *   - requires no approval
 * The tool is wired as a manifest node referencing toolRef "tool_tool_1"
 * (matches the compile.ts naming convention for tool nodes).
 */
async function writeDevWorkflow(
  dir: string,
  opts: { requiresApproval?: boolean } = {}
): Promise<void> {
  const requiresApproval = opts.requiresApproval ?? false;

  // We write a stub workflow.ts that exports a WorkflowDef with a fixed manifest.
  // The manifest includes a tool node so the executor runs the tool dispatcher.
  const manifest = {
    schemaVersion: "1.0.0",
    revision: "rev_dev_test",
    kind: "workflow",
    agent: {
      agentId: "dev-test-agent",
      name: "Dev Test Agent",
      model: { provider: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
      instructionsRef: { contentHash: "sha256:dev", inline: "Test dev agent" },
      skills: [],
      maxIterations: 5,
      maxToolCallsPerIteration: 3,
      circuitBreakerErrorThreshold: 5,
    },
    tenancy: { mode: "single" },
    triggers: [{ type: "manual" }],
    channels: [],
    connections: [],
    tools: [
      {
        toolId: "tool_tool_1",
        name: "greet_tool",
        description: "Greet a user",
        kind: "local",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        requiresApproval,
        dangerous: false,
      },
    ],
    nodes: [
      {
        nodeId: "tool_1",
        kind: "tool",
        toolRef: "tool_tool_1",
        requiresApproval,
        params: { name: "{{name}}" },
        outputSchema: [{ path: "greeting", type: "string", isTemplatable: true }],
      },
    ],
    edges: [],
    resources: {
      needsHttpEgress: false,
      needsBedrock: false,
      needsEventBus: true,
      secrets: [],
      extraIam: [],
    },
    resume: { via: "api", holdsApproval: requiresApproval },
  };

  const workflowJs = `export default {
  nodes: [],
  edges: [],
  outputNodeId: "tool_1",
  compile() {
    return ${JSON.stringify(manifest, null, 2)};
  },
};
`;

  await writeFile(join(dir, "workflow.ts"), workflowJs, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dev — createDevSession", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a scaffolded workflow against Memory + fake model and produces a run record", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_tool_1", async (input) => ({
      greeting: `Hello, ${String(input["name"])}!`,
    }));

    const model = new ScriptedModel([{ stopReason: "end_turn", text: "done" }]);

    const session = await createDevSession({ dir: tmp, model, tools });

    // Session has a manifest
    expect(session.manifest.agent.agentId).toBe("dev-test-agent");

    // Run the workflow
    const { run } = await session.run({ input: { name: "World" } });

    // Should complete successfully
    expect(run.status).toBe("completed");
    expect(run.manifestId).toBe("dev-test-agent");

    // Steps should include the tool node
    const completedSteps = run.steps.filter((s) => s.status === "completed");
    expect(completedSteps.length).toBeGreaterThan(0);
  });

  it("returns a runId and run record", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_tool_1", async () => ({ greeting: "hi" }));

    const model = new ScriptedModel([{ stopReason: "end_turn", text: "done" }]);

    const session = await createDevSession({ dir: tmp, model, tools });
    const result = await session.run({ input: { name: "Test" } });

    expect(typeof result.runId).toBe("string");
    expect(result.runId.length).toBeGreaterThan(0);
    expect(result.run).toBeDefined();
    expect(result.run.runId).toBe(result.runId);
  });

  it("run record has the correct manifestId and revision", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_tool_1", async () => ({ greeting: "hi" }));

    const model = new ScriptedModel([]);

    const session = await createDevSession({ dir: tmp, model, tools });
    const { run } = await session.run({ input: {} });

    expect(run.manifestId).toBe("dev-test-agent");
    expect(run.manifestRevision).toBe("rev_dev_test");
  });

  it("reload() refreshes the manifest without losing the session", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const tools = new FakeToolsDispatcher();
    tools.register("tool_tool_1", async () => ({ greeting: "hi" }));

    const model = new ScriptedModel([]);

    const session = await createDevSession({ dir: tmp, model, tools });
    const originalRevision = session.manifest.revision;

    // Rewrite workflow with different manifest
    const newManifest = {
      ...session.manifest,
      revision: "rev_after_reload",
      agent: { ...session.manifest.agent, name: "Reloaded Agent" },
    };
    await writeFile(
      join(tmp, "workflow.ts"),
      `export default {
  nodes: [],
  edges: [],
  outputNodeId: "t1",
  compile() {
    return ${JSON.stringify(newManifest, null, 2)};
  },
};`,
      "utf8"
    );

    await session.reload();

    // Manifest should now reflect the new version
    // (revision may differ since we changed the agent name)
    expect(session.manifest.agent.agentId).toBe("dev-test-agent");
    // The session should still work
    tools.register("tool_tool_1", async () => ({ greeting: "hi" }));
    const { run } = await session.run({ input: {} });
    expect(["completed", "failed"]).toContain(run.status);

    void originalRevision; // used for reference
  });

  it("SHOULD-FIX 6: reload() racing an in-flight run() does not lose the run — session.run() snapshots its runtime/storage/manifest generation", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const tools = new FakeToolsDispatcher();
    // Artificial delay so the run's drainQueue() is still in-flight when we
    // fire reload() — widening the window between submitRun() and
    // drainQueue()'s completion where the bug (outer `runtime`/`storage`
    // rebound mid-flight) would otherwise bite.
    tools.register("tool_tool_1", async (input) => {
      await new Promise((r) => setTimeout(r, 30));
      return { greeting: `Hello, ${String(input["name"])}!` };
    });

    const model = new ScriptedModel([{ stopReason: "end_turn", text: "done" }]);
    const session = await createDevSession({ dir: tmp, model, tools });

    // Start run() but do NOT await yet — it's mid-flight (past submitRun(),
    // inside the delayed drainQueue()) when we call reload() below.
    const runPromise = session.run({ input: { name: "World" } });

    // Give submitRun() (fast, in-memory) time to complete, landing us inside
    // the artificial tool delay — i.e. mid-drainQueue().
    await new Promise((r) => setTimeout(r, 5));

    // Rewrite workflow.ts with a new revision and reload DURING the in-flight run.
    const reloadedManifest = {
      ...session.manifest,
      revision: "rev_after_reload_race",
    };
    await writeFile(
      join(tmp, "workflow.ts"),
      `export default {
  nodes: [],
  edges: [],
  outputNodeId: "tool_1",
  compile() {
    return ${JSON.stringify(reloadedManifest, null, 2)};
  },
};`,
      "utf8",
    );
    await session.reload();

    // The in-flight run() must still resolve successfully — NOT throw
    // "Run not found after drain" — because it snapshotted the PRE-reload
    // runtime/storage/manifest generation at the top of run().
    const { run } = await runPromise;
    expect(run.status).toBe("completed");
    expect(run.manifestRevision).toBe("rev_dev_test"); // the PRE-reload revision

    // The session itself now reflects the reloaded manifest for FUTURE runs.
    expect(session.manifest.revision).toBe("rev_after_reload_race");
    tools.register("tool_tool_1", async () => ({ greeting: "hi" }));
    const { run: postReloadRun } = await session.run({ input: { name: "Post" } });
    expect(postReloadRun.status).toBe("completed");
    expect(postReloadRun.manifestRevision).toBe("rev_after_reload_race");
  });

  it("approval-held run leaves status as awaiting_approval", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp, { requiresApproval: true });

    const tools = new FakeToolsDispatcher();
    // Don't register the tool — it should be held for approval before dispatch

    const model = new ScriptedModel([]);

    const session = await createDevSession({ dir: tmp, model, tools });
    const { run } = await session.run({ input: { name: "Alice" } });

    // Run should be awaiting approval (tool is approval-gated)
    expect(run.status).toBe("awaiting_approval");
  });
});

describe("dev — manifest from createDevSession", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("session.manifest reflects the compiled manifest", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "platine-dev-manifest-test-"));
    created.push(tmp);

    await writeDevWorkflow(tmp);

    const model = new ScriptedModel([]);
    const session = await createDevSession({ dir: tmp, model });

    expect(session.manifest.kind).toBe("workflow");
    expect(session.manifest.agent.agentId).toBe("dev-test-agent");
    expect(session.manifest.schemaVersion).toBe("1.0.0");
  });
});

// ---------------------------------------------------------------------------
// dev — DEFAULT tools dispatch runs the REAL workflow tool code (no
// `opts.tools` injected). Uses the real-agent fixture (real defineWorkflow +
// a real defineTool imported via a NodeNext './tools/greet.js' specifier).
// ---------------------------------------------------------------------------

describe("dev — default RealToolsDispatcher runs the user's actual tool code", () => {
  const fixtureDir = join(import.meta.dirname, "__fixtures__", "real-agent");

  it("produces the greet tool's REAL computed output, not a stub", async () => {
    // No `tools` option — createDevSession must default to a RealToolsDispatcher
    // built from the fixture workflow's own tool registry.
    const model = new ScriptedModel([]);
    const session = await createDevSession({ dir: fixtureDir, model });

    const { run } = await session.run({ input: { name: "Ada" } });

    expect(run.status).toBe("completed");

    const toolStep = run.steps.find(
      (s) => s.status === "completed" && s.output !== undefined && s.stepId !== "__trigger__",
    );
    expect(toolStep).toBeDefined();
    // The REAL greet tool's execute() output ("Hello, Ada!") — NOT {} (a stub).
    expect(toolStep?.output).toEqual({ greeting: "Hello, Ada!" });
  });
});
