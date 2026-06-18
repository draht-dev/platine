// SPDX-License-Identifier: Apache-2.0
/**
 * deploy.ts — build then shell out to `sst deploy`.
 *
 * Does NOT require AWS at build/test time — the `sst deploy` shell-out is only
 * invoked when called from the CLI. Tests can mock spawnSync / the build step.
 *
 * Flags passed through to sst:
 *   --stage <stage>
 *   --region <region>
 *   Any extra args
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "./build.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeployOptions {
  /** Directory containing workflow.ts (defaults to process.cwd()). */
  dir?: string;
  /** SST stage (e.g. "production", "dev"). */
  stage?: string;
  /** AWS region. */
  region?: string;
  /** Extra args forwarded to `sst deploy`. */
  extraArgs?: string[];
  /** Skip `tsc --noEmit` step during build. Default: false. */
  skipTypecheck?: boolean;
  /**
   * Override the command to run instead of "sst deploy".
   * Used in tests to assert the correct args without executing SST.
   */
  _sstCommand?: string;
}

export interface DeployResult {
  /** Exit code from `sst deploy` (0 = success). */
  exitCode: number;
  /** Combined stdout output. */
  stdout: string;
  /** Combined stderr output. */
  stderr: string;
}

/**
 * Run `platine build` then `sst deploy [--stage] [--region] [extraArgs]`.
 *
 * AWS credentials are NOT checked here; sst handles credential resolution.
 */
export async function deploy(opts: DeployOptions = {}): Promise<DeployResult> {
  const dir = resolve(opts.dir ?? process.cwd());

  // -------------------------------------------------------------------------
  // 1. Build
  // -------------------------------------------------------------------------
  await build({
    dir,
    skipTypecheck: opts.skipTypecheck ?? false,
    write: true,
  });

  // -------------------------------------------------------------------------
  // 2. Assemble sst deploy args
  // -------------------------------------------------------------------------
  const sstCmd = opts._sstCommand ?? "sst";
  const args: string[] = ["deploy"];
  if (opts.stage) {
    args.push("--stage", opts.stage);
  }
  if (opts.region) {
    args.push("--region", opts.region);
  }
  if (opts.extraArgs) {
    args.push(...opts.extraArgs);
  }

  // -------------------------------------------------------------------------
  // 3. Shell out to sst deploy
  // -------------------------------------------------------------------------
  const result = spawnSync(sstCmd, args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (result.error) {
    throw new Error(
      `[platine deploy] Failed to spawn "${sstCmd}": ${result.error.message}\n` +
        `Ensure SST is installed: https://sst.dev/docs/install`
    );
  }

  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
  };
}
