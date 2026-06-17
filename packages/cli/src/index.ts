// SPDX-License-Identifier: Apache-2.0
// @draht/platine CLI stub (P8 implements: init, dev, build, deploy, runs)
//
// Uses node:util parseArgs — no heavy CLI framework.
// Commands:
//   platine init [name]          — scaffold a minimal agent directory
//   platine dev                  — run executor in-process against MemoryStorage/Queue/Bus
//   platine build                — tsc --check then compile → .platine/manifest.json
//   platine deploy               — build → sst deploy
//   platine runs list|get|tail|approve|resume — read Storage directly (--table/DRAHT_TABLE)
//
// `platine dev` does NOT spawn a second `sst dev` multiplexer.
// Runs the same executor.ts as production, behind MemoryStorage adapters.
// Default model provider: Anthropic (ANTHROPIC_API_KEY); deployed default: Bedrock (execution role).

export {};
