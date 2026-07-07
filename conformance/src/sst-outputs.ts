// SPDX-License-Identifier: Apache-2.0
/**
 * sst-outputs.ts — parse the stack outputs block out of `sst deploy` stdout.
 *
 * SST Ion prints a completion marker line ("✓  Complete") followed by an
 * indented block of `<PascalKey>: <value>` lines — one per stack output
 * returned from the `run()` function in sst.config.ts. Example:
 *
 *   ✓  Complete
 *      SupportTriageAgentUrl: https://abc123.lambda-url.eu-central-1.on.aws/
 *      SupportTriageAgentTableName: draht-reference-playbook-ci-1-supporttriageagenttable
 *
 * parseSstOutputs() is a PURE string→Record function — no I/O, no AWS.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the completion marker or the outputs block is absent from the
 * given stdout — i.e. the deploy did not complete, or produced no outputs.
 */
export class MissingOutputError extends Error {
  constructor(reason: string) {
    super(`[sst-outputs] missing SST outputs block: ${reason}`);
    this.name = "MissingOutputError";
  }
}

// ---------------------------------------------------------------------------
// parseSstOutputs
// ---------------------------------------------------------------------------

/** Matches the SST Ion deploy completion marker line (allows surrounding whitespace). */
const COMPLETION_MARKER_RE = /^\s*✓\s+Complete\s*$/;

/** Matches an indented `<PascalKey>: <value>` output line. */
const OUTPUT_LINE_RE = /^\s+([A-Z][A-Za-z0-9]*):\s+(.+?)\s*$/;

/**
 * Extract the `{ key: value }` stack outputs block from `sst deploy` stdout.
 *
 * Algorithm:
 *   1. Find the LAST line matching the completion marker (a deploy that logs
 *      retries may print progress more than once; only the final block matters).
 *   2. Scan subsequent lines; collect every line matching OUTPUT_LINE_RE.
 *   3. Stop collecting at the first blank line encountered AFTER at least one
 *      output has been collected, or at EOF.
 *
 * Throws MissingOutputError when no completion marker is found, or when the
 * marker is found but no output lines follow it.
 */
export function parseSstOutputs(stdout: string): Record<string, string> {
  const lines = stdout.split(/\r?\n/);

  let markerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (COMPLETION_MARKER_RE.test(lines[i] ?? "")) {
      markerIndex = i;
    }
  }

  if (markerIndex === -1) {
    throw new MissingOutputError("no completion marker (\"✓  Complete\") found in stdout");
  }

  const outputs: Record<string, string> = {};
  for (let i = markerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = OUTPUT_LINE_RE.exec(line);
    if (match) {
      const [, key, value] = match;
      if (key !== undefined && value !== undefined) {
        outputs[key] = value;
      }
      continue;
    }
    if (line.trim() === "") {
      if (Object.keys(outputs).length > 0) break;
      continue;
    }
    // Non-blank, non-matching line after the marker — stop scanning. Either
    // the block already ended, or this stdout doesn't have an outputs block
    // in the expected shape.
    break;
  }

  if (Object.keys(outputs).length === 0) {
    throw new MissingOutputError(
      "completion marker found but no \"<PascalKey>: <value>\" output lines followed it",
    );
  }

  return outputs;
}
