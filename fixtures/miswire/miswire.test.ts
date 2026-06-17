// SPDX-License-Identifier: Apache-2.0
/**
 * miswire.test.ts — the mis-wire tsc fixture gate.
 *
 * For each file in cases/*.ts:
 *   (a) FAIL if zero diagnostics (a mis-wire that compiled clean is a BROKEN WEDGE).
 *   (b) FAIL if no diagnostic lands on the `// $ExpectError TSxxxx` annotated line.
 *   (c) WARN (but pass) if a diagnostic lands on the line but the code differs from
 *       the annotation — the line match is the hard gate; code is advisory.
 *
 * For valid/ok.ts:
 *   FAIL if any diagnostics exist (the valid baseline must compile clean).
 *
 * Uses the TypeScript Compiler API directly (more precise line/code mapping than
 * scraping tsc stdout, and consistent with the tsconfig.json in this package).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, it, expect, beforeAll } from "vitest";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.resolve(import.meta.dirname, ".");
const CASES_DIR = path.join(FIXTURE_DIR, "cases");
const VALID_DIR = path.join(FIXTURE_DIR, "valid");
// The harness compiles the intentionally-mis-wired cases/ + the valid/ baseline.
// It uses tsconfig.cases.json (which INCLUDES cases/), NOT tsconfig.json (which
// excludes cases so plain `tsc --noEmit` / `pnpm -r exec tsc` stays clean).
const TSCONFIG_PATH = path.join(FIXTURE_DIR, "tsconfig.cases.json");

// ---------------------------------------------------------------------------
// Parse $ExpectError annotations
// ---------------------------------------------------------------------------

/**
 * Scan a source file for `// $ExpectError TSxxxx` comments.
 * Returns a map of (1-based line number → expected TS error code as number).
 */
function parseExpectErrors(filePath: string): Map<number, number> {
  const src = fs.readFileSync(filePath, "utf8");
  const lines = src.split("\n");
  const result = new Map<number, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = /\/\/\s*\$ExpectError\s+TS(\d+)/.exec(line);
    if (match?.[1] !== undefined) {
      result.set(i + 1, parseInt(match[1], 10)); // 1-based
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build a TypeScript Program from tsconfig.json
// ---------------------------------------------------------------------------

interface ProgramResult {
  program: ts.Program;
  caseFiles: string[];
  validFiles: string[];
}

function buildProgram(): ProgramResult {
  // Read the tsconfig to get compiler options.
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `Failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`
    );
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config as Record<string, unknown>,
    ts.sys,
    FIXTURE_DIR
  );

  if (parsedConfig.errors.length > 0) {
    const msgs = parsedConfig.errors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
      .join("; ");
    throw new Error(`tsconfig.json parse errors: ${msgs}`);
  }

  // Collect case and valid file paths.
  const caseFiles = fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => path.join(CASES_DIR, f));

  const validFiles = fs
    .readdirSync(VALID_DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort()
    .map((f) => path.join(VALID_DIR, f));

  const allFiles = [...caseFiles, ...validFiles];

  const program = ts.createProgram(allFiles, parsedConfig.options);

  return { program, caseFiles, validFiles };
}

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

interface DiagResult {
  code: number;
  /** 1-based line number in the source file. */
  line: number;
  message: string;
}

function getDiagnosticsForFile(
  program: ts.Program,
  filePath: string
): DiagResult[] {
  const sf = program.getSourceFile(filePath);
  if (!sf) {
    throw new Error(`Source file not found in program: ${filePath}`);
  }
  const diags = program.getSemanticDiagnostics(sf);
  return diags
    .filter((d) => d.start !== undefined && d.file !== undefined)
    .map((d) => {
      const pos = d.file!.getLineAndCharacterOfPosition(d.start!);
      return {
        code: d.code,
        line: pos.line + 1, // 0-based → 1-based
        message: ts.flattenDiagnosticMessageText(d.messageText, " "),
      };
    });
}

// ---------------------------------------------------------------------------
// Per-case assertion table
// ---------------------------------------------------------------------------

interface CaseResult {
  file: string;
  annotatedLine: number | null;
  expectedCode: number | null;
  diagnostics: DiagResult[];
  /** true if at least one diagnostic exists */
  hasAnyDiag: boolean;
  /** true if a diagnostic lands on the annotated line */
  diagOnAnnotatedLine: boolean;
  /** true if the diagnostic on the annotated line matches the expected code */
  codeMatches: boolean;
  /** the actual code on the annotated line (if any) */
  actualCodeOnLine: number | null;
  passed: boolean;
  warnings: string[];
}

function evaluateCase(filePath: string, program: ts.Program): CaseResult {
  const annotations = parseExpectErrors(filePath);
  const diagnostics = getDiagnosticsForFile(program, filePath);
  const fileName = path.basename(filePath);
  const warnings: string[] = [];

  // We expect exactly one $ExpectError annotation per case file.
  const annotationEntries = [...annotations.entries()];
  const annotatedLine =
    annotationEntries[0] !== undefined ? annotationEntries[0][0] : null;
  const expectedCode =
    annotationEntries[0] !== undefined ? annotationEntries[0][1] : null;

  const hasAnyDiag = diagnostics.length > 0;

  // Check if any diagnostic is on the annotated line.
  const diagsOnAnnotatedLine = annotatedLine !== null
    ? diagnostics.filter((d) => d.line === annotatedLine)
    : [];

  const diagOnAnnotatedLine = diagsOnAnnotatedLine.length > 0;

  // Check code match.
  const matchingDiag = diagsOnAnnotatedLine.find(
    (d) => expectedCode !== null && d.code === expectedCode
  );
  const codeMatches = matchingDiag !== undefined;

  const actualCodeOnLine =
    diagsOnAnnotatedLine[0] !== undefined ? diagsOnAnnotatedLine[0].code : null;

  if (diagOnAnnotatedLine && !codeMatches && expectedCode !== null) {
    warnings.push(
      `Code mismatch on line ${annotatedLine}: expected TS${expectedCode}, got TS${actualCodeOnLine} — line match passes, code is advisory`
    );
  }

  if (annotatedLine === null) {
    warnings.push(`No $ExpectError annotation found in ${fileName}`);
  }

  // PASS conditions:
  // 1. hasAnyDiag (otherwise the mis-wire compiled clean — BROKEN WEDGE)
  // 2. diagOnAnnotatedLine (error at the right location)
  // (codeMatches is advisory, not hard-fail)
  const passed = hasAnyDiag && diagOnAnnotatedLine;

  return {
    file: fileName,
    annotatedLine,
    expectedCode,
    diagnostics,
    hasAnyDiag,
    diagOnAnnotatedLine,
    codeMatches,
    actualCodeOnLine,
    passed,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Print per-case table
// ---------------------------------------------------------------------------

function printTable(results: CaseResult[], validResults: { file: string; diagCount: number }[]): void {
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  mis-wire fixture gate — per-case results");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(
    `${"FILE".padEnd(25)} ${"ANN.LINE".padEnd(10)} ${"EXP.CODE".padEnd(10)} ${"ACT.CODE".padEnd(10)} ${"ERRORS".padEnd(8)} ${"PASS?"}`
  );
  console.log("─".repeat(80));

  for (const r of results) {
    const pass = r.passed ? "PASS ✓" : "FAIL ✗";
    const errCount = String(r.diagnostics.length).padEnd(8);
    const annLine = r.annotatedLine !== null ? String(r.annotatedLine) : "—";
    const expCode =
      r.expectedCode !== null ? `TS${r.expectedCode}` : "—";
    const actCode =
      r.actualCodeOnLine !== null ? `TS${r.actualCodeOnLine}` : "—";
    const warn = r.warnings.length > 0 ? " ⚠" : "";
    console.log(
      `${r.file.padEnd(25)} ${annLine.padEnd(10)} ${expCode.padEnd(10)} ${actCode.padEnd(10)} ${errCount}${pass}${warn}`
    );
    for (const w of r.warnings) {
      console.log(`  ⚠  ${w}`);
    }
  }

  console.log("─".repeat(80));
  console.log("\n  valid/ baseline:");
  for (const v of validResults) {
    const pass = v.diagCount === 0 ? "PASS ✓ (0 errors)" : `FAIL ✗ (${v.diagCount} errors)`;
    console.log(`  ${v.file.padEnd(25)} ${pass}`);
  }
  console.log("═══════════════════════════════════════════════════════════════════\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let programResult: ProgramResult;

beforeAll(() => {
  programResult = buildProgram();
});

describe("mis-wire fixture gate", () => {
  describe("cases/ — each mis-wired workflow MUST produce a tsc error at the annotated line", () => {
    // Discover case files at describe-time (static list for vitest's test runner).
    const caseFiles = fs
      .readdirSync(CASES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();

    let allResults: CaseResult[] = [];

    for (const fileName of caseFiles) {
      it(`${fileName} — errors at $ExpectError line`, () => {
        const filePath = path.join(CASES_DIR, fileName);
        const result = evaluateCase(filePath, programResult.program);

        // Collect for the summary table.
        allResults.push(result);

        // Hard fail #1: mis-wire compiled clean — BROKEN WEDGE.
        expect(
          result.hasAnyDiag,
          `BROKEN WEDGE: ${fileName} compiled with ZERO errors. ` +
            `The builder API shape no longer rejects this mis-wire at compile time. ` +
            `This is a silent regression — fix the builder before merging.`
        ).toBe(true);

        // Hard fail #2: no diagnostic on the annotated line.
        expect(
          result.annotatedLine,
          `${fileName}: no $ExpectError annotation found — add one at the mis-wired line`
        ).not.toBeNull();

        expect(
          result.diagOnAnnotatedLine,
          `${fileName}: a diagnostic exists but NOT on the $ExpectError line ` +
            `(annotated: ${result.annotatedLine}, actual errors: ${result.diagnostics.map((d) => `line ${d.line} TS${d.code}`).join(", ")}). ` +
            `The error landed at the wrong line — the builder API shape has changed.`
        ).toBe(true);

        // Advisory: code match.
        if (!result.codeMatches && result.warnings.length > 0) {
          console.warn(`[warn] ${result.warnings.join("; ")}`);
        }
      });
    }

    it("summary table (printed to console)", () => {
      // This runs after individual tests; build the full results list.
      if (allResults.length === 0) {
        // Rebuild in case test ordering ran this first.
        allResults = caseFiles.map((f) =>
          evaluateCase(path.join(CASES_DIR, f), programResult.program)
        );
      }

      const validResults = fs
        .readdirSync(VALID_DIR)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => {
          const fp = path.join(VALID_DIR, f);
          const diags = getDiagnosticsForFile(programResult.program, fp);
          return { file: f, diagCount: diags.length };
        });

      printTable(allResults, validResults);

      // Just a sanity assertion — the real assertions are per-case above.
      expect(allResults.length).toBe(caseFiles.length);
    });
  });

  describe("valid/ — correct workflows MUST compile with zero errors", () => {
    const validFiles = fs
      .readdirSync(VALID_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();

    for (const fileName of validFiles) {
      it(`${fileName} — zero diagnostics`, () => {
        const filePath = path.join(VALID_DIR, fileName);
        const diags = getDiagnosticsForFile(programResult.program, filePath);

        if (diags.length > 0) {
          const details = diags
            .map((d) => `  line ${d.line} TS${d.code}: ${d.message}`)
            .join("\n");
          expect.fail(
            `${fileName} compiled with ${diags.length} error(s) — the valid baseline is broken:\n${details}`
          );
        }

        expect(diags.length).toBe(0);
      });
    }
  });
});
