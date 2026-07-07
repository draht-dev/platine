// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSstOutputs, MissingOutputError } from "./sst-outputs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "../fixtures/deploy-stdout.txt");

describe("parseSstOutputs", () => {
  it("extracts all four documented outputs from the committed deploy-stdout fixture", async () => {
    const stdout = await readFile(FIXTURE_PATH, "utf8");
    const outputs = parseSstOutputs(stdout);

    expect(outputs["SupportTriageAgentUrl"]).toMatch(/^https:\/\/.+\.lambda-url\..+\.on\.aws\/$/);
    expect(outputs["SupportTriageAgentTableName"]).toBe(
      "draht-reference-playbook-ci-1234567890-supporttriageagenttabletable",
    );
    expect(outputs["SupportTriageAgentResumeUrl"]).toMatch(/^https:\/\/.+\.lambda-url\..+\.on\.aws\/$/);
    expect(outputs["SupportTriageAgentManifestRevision"]).toBe("rev_a3f91c08b7");
  });

  it("throws MissingOutputError when there is no completion marker", () => {
    const stdout = "SST 3.15.2  ready!\n\n~  Deploy\n\n|  Created  SomethingElse\n";
    expect(() => parseSstOutputs(stdout)).toThrow(MissingOutputError);
  });

  it("throws MissingOutputError when the marker is present but no outputs follow", () => {
    const stdout = "~  Deploy\n\n✓  Complete\n\n";
    expect(() => parseSstOutputs(stdout)).toThrow(MissingOutputError);
  });

  it("throws MissingOutputError on empty stdout", () => {
    expect(() => parseSstOutputs("")).toThrow(MissingOutputError);
  });

  it("uses the LAST completion marker when progress logs retry", () => {
    const stdout = [
      "✓  Complete",
      "   StaleKey: stale-value",
      "",
      "~  Deploy (retry)",
      "✓  Complete",
      "   FreshUrl: https://fresh.example.com/",
    ].join("\n");

    const outputs = parseSstOutputs(stdout);
    expect(outputs).toEqual({ FreshUrl: "https://fresh.example.com/" });
    expect(outputs["StaleKey"]).toBeUndefined();
  });
});
