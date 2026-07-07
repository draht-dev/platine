// SPDX-License-Identifier: Apache-2.0
/**
 * checks.test.ts — CHECKS registry unit tests. Injected in-memory Storage,
 * ZERO network (postJson/postJsonSigned are hand-rolled fakes that manipulate
 * MemoryStorage directly, mirroring what harness.ts's --dry-run mode does).
 */

import { describe, it, expect, afterEach } from "vitest";
import { MemoryStorage } from "@draht/runtime-aws";
import { DEFAULT_TENANT } from "@draht/core/seams";
import { CHECKS } from "./checks.js";
import type { CheckContext, CheckState } from "./checks.js";
import { makeFakeBackend, FAKE_BACKEND_CLASSIFY_NODE_ID } from "./fake-backend.js";

const HTTP_URL = "https://fake-ingress.example/";
const RESUME_URL = "https://fake-resume.example/";

function makeContext(storage: MemoryStorage, overrides: Partial<CheckContext> = {}): CheckContext {
  const tenantId = DEFAULT_TENANT;
  const { postJson, postJsonSigned } = makeFakeBackend(
    storage,
    tenantId,
    { httpUrl: HTTP_URL, resumeUrl: RESUME_URL },
    "rev_test",
  );
  const state: CheckState = {};
  return {
    httpUrl: HTTP_URL,
    resumeUrl: RESUME_URL,
    region: "eu-central-1",
    storage,
    tenantId,
    state,
    postJson,
    postJsonSigned,
    redeploy: async () => {},
    pollIntervalMs: 1,
    pollTimeoutMs: 2000,
    ...overrides,
  };
}

describe("CHECKS registry", () => {
  it("is ordered t3, t6-hold, t5-redeploy, t6-resume-iam, tool-output", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      "t3-http-roundtrip",
      "t6-approval-hold",
      "t5-survives-redeploy",
      "t6-resume-iam",
      "tool-output",
    ]);
  });

  describe("tool-output skip logic", () => {
    const original = process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
    afterEach(() => {
      if (original === undefined) delete process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
      else process.env["DRAHT_ASSERT_TOOL_OUTPUT"] = original;
    });

    it("is skipped by default", async () => {
      delete process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
      const storage = new MemoryStorage();
      const check = CHECKS.find((c) => c.id === "tool-output");
      expect(check?.requires).toBe("tool-output");
      const result = await check!.run(makeContext(storage));
      expect(result.status).toBe("skipped");
      expect(result.detail).toContain("DRAHT_ASSERT_TOOL_OUTPUT=1");
    });

    it("fails cleanly (not skipped) when DRAHT_ASSERT_TOOL_OUTPUT=1 but no run context is available", async () => {
      process.env["DRAHT_ASSERT_TOOL_OUTPUT"] = "1";
      const storage = new MemoryStorage();
      const check = CHECKS.find((c) => c.id === "tool-output");
      const result = await check!.run(makeContext(storage));
      expect(result.status).toBe("fail");
    });
  });

  describe("tool-output real assertion (DRAHT_ASSERT_TOOL_OUTPUT=1)", () => {
    const original = process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
    afterEach(() => {
      if (original === undefined) delete process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
      else process.env["DRAHT_ASSERT_TOOL_OUTPUT"] = original;
    });

    /** Runs t3 → t6-approval-hold so ctx.state carries a real runId + escalateNodeId. */
    async function runT3ThroughT6Hold(storage: MemoryStorage): Promise<CheckContext> {
      const ctx = makeContext(storage);
      const t3 = CHECKS.find((c) => c.id === "t3-http-roundtrip")!;
      const t3Result = await t3.run(ctx);
      expect(t3Result.status).toBe("pass");
      const t6Hold = CHECKS.find((c) => c.id === "t6-approval-hold")!;
      const holdResult = await t6Hold.run(ctx);
      expect(holdResult.status).toBe("pass");
      return ctx;
    }

    it("passes when the classify node's SIDEEFFECT# row holds a non-empty, real-looking output", async () => {
      process.env["DRAHT_ASSERT_TOOL_OUTPUT"] = "1";
      const storage = new MemoryStorage();
      const ctx = await runT3ThroughT6Hold(storage);
      const runId = ctx.state.runId!;

      // Seed a real-looking SIDEEFFECT# row for the classify node — the
      // fake backend only appends a checkpoint for it, since writing the
      // ledger row is the real executor's job on a real deploy.
      await storage.commitStepWithSideEffect(
        {
          tenantId: ctx.tenantId,
          runId,
          stepId: FAKE_BACKEND_CLASSIFY_NODE_ID,
          status: "completed",
          output: { category: "billing", severity: "high", summary: "charged twice" },
        },
        {
          tenantId: ctx.tenantId,
          runId,
          nodeId: FAKE_BACKEND_CLASSIFY_NODE_ID,
          idempotencyKey: `${runId}:${FAKE_BACKEND_CLASSIFY_NODE_ID}`,
          toolName: "classify",
          result: { category: "billing", severity: "high", summary: "charged twice" },
        },
      );

      const check = CHECKS.find((c) => c.id === "tool-output")!;
      const result = await check.run(ctx);
      expect(result.status).toBe("pass");
      expect(result.detail).toContain("non-empty object");
    });

    it("fails when the classify node's SIDEEFFECT# row holds an empty {} stub output", async () => {
      process.env["DRAHT_ASSERT_TOOL_OUTPUT"] = "1";
      const storage = new MemoryStorage();
      const ctx = await runT3ThroughT6Hold(storage);
      const runId = ctx.state.runId!;

      await storage.commitStepWithSideEffect(
        {
          tenantId: ctx.tenantId,
          runId,
          stepId: FAKE_BACKEND_CLASSIFY_NODE_ID,
          status: "completed",
          output: {},
        },
        {
          tenantId: ctx.tenantId,
          runId,
          nodeId: FAKE_BACKEND_CLASSIFY_NODE_ID,
          idempotencyKey: `${runId}:${FAKE_BACKEND_CLASSIFY_NODE_ID}`,
          toolName: "classify",
          result: {},
        },
      );

      const check = CHECKS.find((c) => c.id === "tool-output")!;
      const result = await check.run(ctx);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("empty/stub");
    });

    it("skips (does not assert) when DRAHT_ASSERT_TOOL_OUTPUT is unset, even with a seeded SIDEEFFECT# row", async () => {
      delete process.env["DRAHT_ASSERT_TOOL_OUTPUT"];
      const storage = new MemoryStorage();
      const ctx = await runT3ThroughT6Hold(storage);

      const check = CHECKS.find((c) => c.id === "tool-output")!;
      const result = await check.run(ctx);
      expect(result.status).toBe("skipped");
    });
  });

  it("t3 → t6-approval-hold → t6-resume-iam pass in sequence against a shared ctx.state", async () => {
    const storage = new MemoryStorage();
    const ctx = makeContext(storage);

    const t3 = CHECKS.find((c) => c.id === "t3-http-roundtrip")!;
    const t3Result = await t3.run(ctx);
    expect(t3Result.status).toBe("pass");
    expect(ctx.state.runId).toBeDefined();

    const t6Hold = CHECKS.find((c) => c.id === "t6-approval-hold")!;
    const holdResult = await t6Hold.run(ctx);
    expect(holdResult.status).toBe("pass");
    expect(ctx.state.actionId).toBeDefined();

    const t6Resume = CHECKS.find((c) => c.id === "t6-resume-iam")!;
    const resumeResult = await t6Resume.run(ctx);
    expect(resumeResult.status).toBe("pass");

    const finalRun = await storage.getRun(ctx.tenantId, ctx.state.runId!);
    expect(finalRun?.status).toBe("completed");
  });

  it("t5-survives-redeploy is independently addressable (runs standalone without ctx.state from t3/t6-hold)", async () => {
    const storage = new MemoryStorage();
    const ctx = makeContext(storage); // fresh ctx.state — never touched by t3/t6-hold

    const t5 = CHECKS.find((c) => c.id === "t5-survives-redeploy")!;
    const result = await t5.run(ctx);
    expect(result.status).toBe("pass");
    // t5 never wrote to ctx.state — it manages its own run entirely internally.
    expect(ctx.state.runId).toBeUndefined();
  });

  it("t6-approval-hold fails cleanly when run standalone with no prior runId in state", async () => {
    const storage = new MemoryStorage();
    const ctx = makeContext(storage);
    const t6Hold = CHECKS.find((c) => c.id === "t6-approval-hold")!;
    const result = await t6Hold.run(ctx);
    expect(result.status).toBe("fail");
  });
});
