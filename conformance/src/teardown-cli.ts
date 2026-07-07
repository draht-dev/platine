// SPDX-License-Identifier: Apache-2.0
/**
 * teardown-cli.ts — thin CLI wrapper over teardownStage(), used as the
 * `if: always()` guaranteed-teardown step in .github/workflows/real-aws.yml.
 *
 * Usage:
 *   tsx src/teardown-cli.ts --stage <stage> --region <region> --dir <path>
 *
 * Runs even when the harness itself failed partway through (the workflow
 * step invoking this has `if: always()`), so a throwaway stage never leaks.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { teardownStage } from "./teardown.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      stage: { type: "string" },
      region: { type: "string" },
      dir: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });

  const stage = values["stage"] as string | undefined;
  const region = (values["region"] as string | undefined) ?? "eu-central-1";
  const dir = resolve((values["dir"] as string | undefined) ?? "examples/reference-playbook");

  if (!stage) {
    console.error("[teardown-cli] --stage is required");
    process.exit(2);
  }

  console.log(`[teardown-cli] tearing down stage=${stage} region=${region} dir=${dir}`);
  const report = await teardownStage({ stage, region, dir });
  console.log(
    `[teardown-cli] done. sstRemoveExitCode=${report.sstRemoveExitCode} tablesDeleted=${JSON.stringify(report.tablesDeleted)}`,
  );
}

main().catch((err: unknown) => {
  console.error(`[teardown-cli] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
