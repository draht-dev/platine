// SPDX-License-Identifier: Apache-2.0
import { resolve } from "node:path";

/**
 * Single source of truth for resolving @draht/* workspace deps to their SOURCE
 * files during vitest runs. This lets tests reflect current source without a
 * rebuild, and — critically — keeps resolution consistent across every package
 * so a package never silently fails to discover an import it didn't pre-alias.
 *
 * Longest keys first: vite matches alias prefixes, so a more specific subpath
 * (e.g. ".../handlers") must precede its parent (".../runtime-aws").
 *
 * When a new @draht/* package or subpath export is added, add it here.
 */
export function drahtAliases(root: string): Record<string, string> {
  const p = (rel: string) => resolve(root, rel);
  return {
    "@draht/core/define-tool": p("packages/core/src/define-tool.ts"),
    "@draht/core/define-agent": p("packages/core/src/define-agent.ts"),
    "@draht/core/define-workflow": p("packages/core/src/define-workflow.ts"),
    "@draht/core/manifest": p("packages/core/src/manifest/index.ts"),
    "@draht/core/seams": p("packages/core/src/seams/index.ts"),
    "@draht/core/compile": p("packages/core/src/compile.ts"),
    "@draht/manifest": p("packages/manifest/src/index.ts"),
    "@draht/model": p("packages/model/src/index.ts"),
    "@draht/runtime-aws/handlers": p("packages/runtime-aws/src/handlers/index.ts"),
    "@draht/runtime-aws": p("packages/runtime-aws/src/index.ts"),
    "@draht/sst": p("packages/sst/src/index.ts"),
  };
}
