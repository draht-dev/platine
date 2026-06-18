// SPDX-License-Identifier: Apache-2.0
/**
 * init.ts — scaffold a minimal agent directory.
 *
 * Usage:
 *   platine init [name]              — scaffold agent.md + workflow.ts + tools/ + sst.ts
 *   platine init [name] -t workflow  — same (alias; "workflow" is the default template)
 *
 * Files created (relative to cwd/<name>/):
 *   agent.md          — instructions file (system prompt)
 *   workflow.ts       — defineWorkflow + defineAgent using @draht/core
 *   tools/greet.ts    — example defineTool
 *   sst.ts            — draht.Agent SST factory snippet
 */

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function agentMdTemplate(name: string): string {
  return `# ${name}

You are a helpful assistant.

## Skills

- Greet users by name
- Answer general questions
`.trimStart();
}

function workflowTsTemplate(name: string): string {
  const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return `// SPDX-License-Identifier: Apache-2.0
import { z } from "zod/v4";
import { defineWorkflow, defineAgent } from "@draht/core/define-workflow";
import { greet } from "./tools/greet.js";

/**
 * ${name} workflow — edit this file to build your agent graph.
 */

const ${safeName}Agent = defineAgent({
  model: "anthropic/claude-haiku-4-5",
  instructions: "You are a helpful assistant. Use the greet tool when asked.",
  tools: [greet],
  maxIterations: 5,
});

export default defineWorkflow((b) => {
  const trigger = b.trigger({
    type: "manual",
    payload: z.object({ name: z.string() }),
  });

  const greeted = b.node(greet, trigger, (p) => ({ name: p.name }));

  return b.output(greeted);
});
`.trimStart();
}

function toolsGreetTsTemplate(): string {
  return `// SPDX-License-Identifier: Apache-2.0
import { z } from "zod/v4";
import { defineTool } from "@draht/core/define-tool";

/**
 * greet — example tool. Returns a greeting string.
 */
export const greet = defineTool({
  description: "Greet a user by name",
  inputSchema: z.object({
    name: z.string().describe("The name to greet"),
  }),
  outputSchema: z.object({
    greeting: z.string(),
  }),
  execute: async ({ name }) => ({
    greeting: \`Hello, \${name}! Welcome to draht.\`,
  }),
});
`.trimStart();
}

function sstTsTemplate(name: string): string {
  return `// SPDX-License-Identifier: Apache-2.0
/**
 * sst.ts — SST factory snippet for ${name}.
 *
 * Add this to your infra/ directory and import it in sst.config.ts:
 *
 *   import { ${name}Agent } from "./infra/${name}";
 *   // ...
 *   return { ${name}Url: ${name}Agent.httpUrl };
 *
 * Requires: sst ^4.15.x, @draht/sst installed.
 */
import { draht } from "@draht/sst";

export const ${name}Agent = draht.Agent("${name}", {
  manifest: "./.platine/manifest.json",
  model: { provider: "bedrock", defaultModel: "eu.anthropic.claude-haiku-4-5" },
  storage: { mode: "managed", retain: true },
  channels: [{ kind: "http" }],
  tenancy: { mode: "single" },
  timeout: "14 minutes",
});
`.trimStart();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Agent/workflow name (defaults to "my-agent"). */
  name?: string;
  /** Template variant. Currently only "workflow" is supported. */
  template?: string;
  /** Base directory to scaffold into. Defaults to process.cwd(). */
  cwd?: string;
}

export interface InitResult {
  /** Absolute path to the created agent directory. */
  dir: string;
  /** Relative paths to created files (relative to dir). */
  files: string[];
}

/** Scaffold an agent directory. Returns the created paths. */
export async function init(opts: InitOptions = {}): Promise<InitResult> {
  const name = (opts.name ?? "my-agent").replace(/\s+/g, "-");
  const cwd = opts.cwd ?? process.cwd();
  const template = opts.template ?? "workflow";

  if (template !== "workflow") {
    throw new Error(`Unknown template "${template}". Only "workflow" is supported.`);
  }

  const dir = join(cwd, name);

  // Guard: don't overwrite an existing directory
  try {
    await access(dir);
    throw new Error(
      `Directory already exists: ${dir}\nChoose a different name or remove the existing directory.`
    );
  } catch (err: unknown) {
    // access() throws when the path does NOT exist — that's what we want.
    // Re-throw if the error is our custom message (dir exists).
    if (err instanceof Error && err.message.startsWith("Directory already exists:")) {
      throw err;
    }
    // Otherwise: path doesn't exist → proceed
  }

  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "tools"), { recursive: true });

  const files: string[] = [];

  const write = async (rel: string, content: string): Promise<void> => {
    await writeFile(join(dir, rel), content, "utf8");
    files.push(rel);
  };

  await write("agent.md", agentMdTemplate(name));
  await write("workflow.ts", workflowTsTemplate(name));
  await write("tools/greet.ts", toolsGreetTsTemplate());
  await write("sst.ts", sstTsTemplate(name));

  return { dir, files };
}
