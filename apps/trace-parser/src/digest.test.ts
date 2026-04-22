import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrace } from "./parser.js";
import { renderDigest } from "./digest.js";
import type { TraceMetadata } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../test/fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

describe("renderDigest", () => {
  it("renders a complete digest for the CEO fixture", () => {
    const jsonl = loadFixture("ceo-run.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-ceo-digest" });

    const meta: TraceMetadata = {
      traceId: "test-ceo-digest",
      companyId: "company-123",
      issueId: "issue-456",
      agentId: "agent-789",
      stage: "ceo",
      model: "claude-sonnet-4-6",
      startedAt: new Date("2026-04-22T08:18:00Z"),
      endedAt: new Date("2026-04-22T08:25:00Z"),
      durationMs: 420000,
      outcomeMarker: "success",
    };

    const digest = renderDigest(meta, result, "1.0.0");

    // Structure checks
    expect(digest).toContain("# Trace test-ceo-digest");
    expect(digest).toContain("**Company:** company-123");
    expect(digest).toContain("**Issue:** issue-456");
    expect(digest).toContain("**Agent:** agent-789 (ceo)");
    expect(digest).toContain("**Model:** claude-sonnet-4-6");
    expect(digest).toContain("**Duration:** 420000ms");
    expect(digest).toContain("**Outcome:** success");
    expect(digest).toContain("## Turn summary");
    expect(digest).toContain("## Tool call counts");
    expect(digest).toContain("Parser version: 1.0.0");

    // Table should have rows
    const tableRows = digest.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| #") && !l.startsWith("|--"));
    expect(tableRows.length).toBeGreaterThan(10);
  });

  it("handles traces with no handoffs or warnings", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        model: "test",
        content: [{ type: "text", text: "Simple response" }],
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      timestamp: "2026-01-01T00:00:00Z",
    });

    const result = parseTrace({ jsonl, traceId: "simple" });

    const meta: TraceMetadata = {
      traceId: "simple",
      companyId: "c1",
      issueId: "i1",
      agentId: "a1",
      stage: null,
      model: null,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      endedAt: null,
      durationMs: null,
      outcomeMarker: null,
    };

    const digest = renderDigest(meta, result, "1.0.0");

    expect(digest).toContain("(unknown)");
    expect(digest).not.toContain("## Handoff payloads");
    expect(digest).not.toContain("## Warnings");
    expect(digest).not.toContain("**Duration:**");
    expect(digest).not.toContain("**Outcome:**");
  });
});
