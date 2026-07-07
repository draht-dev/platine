// SPDX-License-Identifier: Apache-2.0
/**
 * tools-dispatcher.test.ts — RealToolsDispatcher acceptance tests.
 *
 * No network, no API keys. Uses defineTool() (zod inputSchema) directly.
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";
import { DEFAULT_TENANT } from "@draht/core/seams";
import { RealToolsDispatcher, type ToolRegistry } from "./tools-dispatcher.js";

const ctx = { idempotencyKey: "run_1#node_1", tenantId: DEFAULT_TENANT };

describe("RealToolsDispatcher", () => {
  it("returns the real computed output of the tool's execute()", async () => {
    const greet = defineTool({
      description: "greet",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      execute: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
    });

    const registry: ToolRegistry = new Map([["tool_1", greet]]);
    const dispatcher = new RealToolsDispatcher(registry);

    const out = await dispatcher.execute("tool_1", { name: "World" }, ctx);
    expect(out).toEqual({ greeting: "Hello, World!" });
  });

  it("throws for an unregistered toolRef", async () => {
    const registry: ToolRegistry = new Map();
    const dispatcher = new RealToolsDispatcher(registry);

    await expect(
      dispatcher.execute("tool_missing", {}, ctx),
    ).rejects.toThrow(/no tool registered for tool_missing/);
  });

  it("rejects invalid input BEFORE calling execute() (spy not invoked)", async () => {
    const executeSpy = vi.fn(async ({ name }: { name: string }) => ({
      greeting: `Hello, ${name}!`,
    }));

    const greet = defineTool({
      description: "greet",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      execute: executeSpy,
    });

    const registry: ToolRegistry = new Map([["tool_1", greet]]);
    const dispatcher = new RealToolsDispatcher(registry);

    await expect(
      dispatcher.execute("tool_1", { name: 42 }, ctx),
    ).rejects.toThrow(/invalid input for tool tool_1/);

    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("hasSideEffect always returns true", () => {
    const dispatcher = new RealToolsDispatcher(new Map());
    expect(dispatcher.hasSideEffect("anything")).toBe(true);
  });
});
