import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTrace } from "./parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../test/fixtures");

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), "utf-8");
}

describe("parseTrace", () => {
  describe("CEO fixture", () => {
    it("produces expected event counts", () => {
      const jsonl = loadFixture("ceo-run.jsonl");
      const result = parseTrace({ jsonl, traceId: "test-ceo" });

      // 19 assistant lines, 13 user lines, 6 attachment lines in fixture
      // assistant events produce: text + tool_use events
      // user events produce: tool_result events (only from array content with tool_result blocks)
      // attachments produce: tool_result for hook_success only

      const textEvents = result.events.filter((e) => e.eventType === "assistant_text");
      const toolUseEvents = result.events.filter((e) => e.eventType === "tool_use");
      const toolResultEvents = result.events.filter((e) => e.eventType === "tool_result");

      expect(textEvents.length).toBeGreaterThan(0);
      expect(toolUseEvents.length).toBeGreaterThan(0);
      expect(toolResultEvents.length).toBeGreaterThan(0);

      // Total events should cover all extractable content
      expect(result.events.length).toBeGreaterThan(20);

      // Should have tool call counts
      expect(Object.keys(result.summary.toolCallCounts).length).toBeGreaterThan(0);

      // Token totals should be populated
      expect(result.summary.totalTokensIn).toBeGreaterThan(0);
      expect(result.summary.totalTokensOut).toBeGreaterThan(0);
      expect(result.summary.totalTurns).toBeGreaterThan(0);
    });

    it("extracts known tool names", () => {
      const jsonl = loadFixture("ceo-run.jsonl");
      const result = parseTrace({ jsonl, traceId: "test-ceo" });

      const toolNames = new Set(
        result.events
          .filter((e) => e.eventType === "tool_use")
          .map((e) => e.toolName),
      );

      // CEO trace uses Bash, Glob, Read, Skill
      expect(toolNames.has("Bash")).toBe(true);
      expect(toolNames.has("Read")).toBe(true);
    });

    it("computes tool durations for tool_result events", () => {
      const jsonl = loadFixture("ceo-run.jsonl");
      const result = parseTrace({ jsonl, traceId: "test-ceo" });

      const resultsWithDuration = result.events.filter(
        (e) => e.eventType === "tool_result" && e.toolDurationMs !== null,
      );

      // At least some tool results should have computed durations
      expect(resultsWithDuration.length).toBeGreaterThan(0);
      for (const r of resultsWithDuration) {
        expect(r.toolDurationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("unknown-stage fixture", () => {
    it("parses without errors", () => {
      const jsonl = loadFixture("unknown-stage-run.jsonl");
      const result = parseTrace({ jsonl, traceId: "test-unknown" });

      expect(result.events.length).toBeGreaterThan(0);
      expect(result.summary.totalTurns).toBeGreaterThan(0);

      // No malformed line warnings expected
      const malformed = result.warnings.filter((w) => w.startsWith("malformed_jsonl_line"));
      expect(malformed).toHaveLength(0);
    });
  });

  it("ignores queue-operation and last-prompt events", () => {
    const jsonl = [
      JSON.stringify({ type: "queue-operation", operation: "test", timestamp: "2026-01-01T00:00:00Z", sessionId: "s1", content: {} }),
      JSON.stringify({ type: "last-prompt", timestamp: "2026-01-01T00:00:01Z" }),
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          model: "test",
          content: [{ type: "text", text: "Hello" }],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp: "2026-01-01T00:00:02Z",
      }),
    ].join("\n");

    const result = parseTrace({ jsonl, traceId: "test-skip" });

    // Only the assistant event should produce output
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe("assistant_text");
  });

  it("handles malformed lines with warning", () => {
    const jsonl = [
      "not valid json {{{",
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: {
          model: "test",
          content: [{ type: "text", text: "Works" }],
          usage: { input_tokens: 5, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp: "2026-01-01T00:00:00Z",
      }),
    ].join("\n");

    const result = parseTrace({ jsonl, traceId: "test-malformed" });

    expect(result.warnings).toContain("malformed_jsonl_line_1");
    expect(result.events).toHaveLength(1);
  });

  it("detects spec handoff from put_issue_document", () => {
    const jsonl = loadFixture("synthetic-handoff.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-handoff" });

    const specHandoffs = result.handoffs.filter((h) => h.payloadType === "spec");
    expect(specHandoffs.length).toBeGreaterThanOrEqual(1);

    // First spec handoff is from put_issue_document key=spec
    const specFromDoc = specHandoffs[0];
    expect(specFromDoc.payloadContent).toHaveProperty("body");
    expect(specFromDoc.payloadContent).toHaveProperty("title", "Feature Spec");
  });

  it("detects spec handoff from update_issue description", () => {
    const jsonl = loadFixture("synthetic-handoff.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-handoff" });

    const specHandoffs = result.handoffs.filter((h) => h.payloadType === "spec");
    // Should have two spec handoffs: one from put_issue_document, one from update_issue
    expect(specHandoffs.length).toBeGreaterThanOrEqual(2);

    const fromUpdate = specHandoffs.find(
      (h) => (h.payloadContent as Record<string, unknown>).description !== undefined,
    );
    expect(fromUpdate).toBeDefined();
    expect((fromUpdate!.payloadContent as Record<string, unknown>).acceptanceCriteria).toBeDefined();
  });

  it("detects diff handoff from comment_on_issue with PR URL", () => {
    const jsonl = loadFixture("synthetic-handoff.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-handoff" });

    const diffHandoffs = result.handoffs.filter((h) => h.payloadType === "diff");
    expect(diffHandoffs).toHaveLength(1);

    const diff = diffHandoffs[0].payloadContent as Record<string, unknown>;
    expect(diff.detectedPrUrl).toBe("https://github.com/michaelkd01/paperclip/pull/42");
    expect(diff.detectedSha).toBe("a1b2c3d4e5f6");
  });

  it("detects verdict handoff from put_issue_document key=outcome", () => {
    const jsonl = loadFixture("synthetic-handoff.jsonl");
    const result = parseTrace({ jsonl, traceId: "test-handoff" });

    const verdicts = result.handoffs.filter((h) => h.payloadType === "verdict");
    expect(verdicts).toHaveLength(1);
  });

  it("detects multi-iteration turn warning", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        model: "test",
        content: [{ type: "text", text: "Multi-iteration" }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          iterations: [
            { input_tokens: 50, output_tokens: 25, type: "message" },
            { input_tokens: 50, output_tokens: 25, type: "message" },
            { input_tokens: 50, output_tokens: 25, type: "message" },
          ],
        },
      },
      timestamp: "2026-01-01T00:00:00Z",
    });

    const result = parseTrace({ jsonl, traceId: "test-multi-iter" });

    const iterWarnings = result.warnings.filter((w) => w.startsWith("multi_iteration_turn"));
    expect(iterWarnings).toHaveLength(1);
    expect(iterWarnings[0]).toContain("iterations=3");
  });

  it("detects decision points", () => {
    const jsonl = JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: {
        model: "test",
        content: [
          { type: "text", text: "I'll check the files and run the tests." },
          { type: "tool_use", id: "t1", name: "Read", input: { path: "/foo" } },
          { type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } },
        ],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      timestamp: "2026-01-01T00:00:00Z",
    });

    const result = parseTrace({ jsonl, traceId: "test-decision" });

    const decisions = result.events.filter((e) => e.eventType === "decision_point");
    expect(decisions).toHaveLength(1);
    expect(decisions[0].contentSummary).toContain("Read");
    expect(decisions[0].contentSummary).toContain("Bash");
  });

  it("skips unknown event types with warning", () => {
    const jsonl = JSON.stringify({ type: "mystery_event", data: "unknown" });

    const result = parseTrace({ jsonl, traceId: "test-unknown-type" });

    expect(result.events).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("unknown_event_type_mystery_event"))).toBe(true);
  });
});
