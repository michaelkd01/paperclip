import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolUseResultPreview } from "./parser.js";
import { parseTrace } from "./parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../test/fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

describe("buildToolUseResultPreview", () => {
  it("returns the input string when result is a short string", () => {
    const input = "Error: Exit code 1\n";
    const result = buildToolUseResultPreview(input as any);
    expect(result).toBe(input);
  });

  it("truncates a long string to 200 chars", () => {
    const input = "x".repeat(300);
    const result = buildToolUseResultPreview(input as any);
    expect(result).toBe("x".repeat(200));
  });

  it("returns null when result is null", () => {
    const result = buildToolUseResultPreview(null as any);
    expect(result).toBeNull();
  });

  it("returns null when result is undefined", () => {
    const result = buildToolUseResultPreview(undefined as any);
    expect(result).toBeNull();
  });

  it("returns null for non-plain-object non-string types", () => {
    expect(buildToolUseResultPreview(42 as any)).toBeNull();
    expect(buildToolUseResultPreview(true as any)).toBeNull();
    expect(buildToolUseResultPreview([1, 2, 3] as any)).toBeNull();
  });

  it("handles object with stdout (existing behaviour)", () => {
    const result = buildToolUseResultPreview({
      stdout: "hello world",
      stderr: "",
      exitCode: 0,
    });
    expect(result).toContain("exit=0");
    expect(result).toContain("stdout=hello world");
  });

  it("returns null for object without matching keys", () => {
    const result = buildToolUseResultPreview({ someRandomKey: "value" });
    expect(result).toBeNull();
  });
});

describe("parseTrace with string toolUseResult fixture", () => {
  it("parses without throwing and returns non-empty events", () => {
    const jsonl = loadFixture("string-tool-use-result.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-string-tool-use-result" });
    expect(result.events.length).toBeGreaterThan(0);
  });
});
