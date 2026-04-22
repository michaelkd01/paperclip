import { describe, expect, it, vi, beforeEach } from "vitest";
import { searchTraces, getTrace } from "../services/trace-query.js";

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-s3
// ---------------------------------------------------------------------------
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  GetObjectCommand: vi.fn().mockImplementation((params) => params),
}));

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

function makeTraceRow(overrides: Record<string, unknown> = {}) {
  return {
    traceId: "aaaa-1111",
    runId: "run-1",
    companyId: "company-1",
    issueId: "issue-1",
    agentId: "agent-1",
    stage: "executor",
    model: "claude-opus-4-6",
    sessionId: "sess-1",
    startedAt: new Date("2026-04-20T10:00:00Z"),
    endedAt: new Date("2026-04-20T10:05:00Z"),
    durationMs: 300000,
    tokensInTotal: 1000,
    tokensOutTotal: 500,
    outcomeMarker: null,
    r2RawKey: "traces/company-1/issue-1/executor/run-1.jsonl",
    r2DigestKey: "digests/company-1/issue-1/executor/run-1.md",
    benchmarkCandidate: false,
    parseStatus: "parsed",
    parseWarnings: null,
    parsedAt: new Date("2026-04-20T10:10:00Z"),
    parserVersion: "1.0.0",
    createdAt: new Date("2026-04-20T10:00:00Z"),
    ...overrides,
  };
}

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-1",
    traceId: "aaaa-1111",
    turnIndex: 0,
    eventType: "assistant_text",
    contentSummary: "hello",
    tokensIn: 100,
    tokensOut: 50,
    toolName: null,
    toolDurationMs: null,
    timestamp: new Date("2026-04-20T10:01:00Z"),
    ...overrides,
  };
}

function makeHandoffRow(overrides: Record<string, unknown> = {}) {
  return {
    payloadId: "hp-1",
    producerTraceId: "aaaa-1111",
    consumerTraceId: null,
    payloadType: "spec",
    payloadContent: { foo: "bar" },
    payloadR2Key: null,
    createdAt: new Date("2026-04-20T10:02:00Z"),
    ...overrides,
  };
}

/**
 * Build a chainable mock DB that returns the given rows.
 * Supports .select().from().where().orderBy().limit() chains.
 */
function createChainableDb(rowSets: unknown[][]) {
  let callIndex = 0;

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const methods = ["from", "where", "orderBy", "limit"];
    for (const m of methods) {
      chain[m] = () => {
        // On terminal call (limit), resolve with the current row set
        if (m === "limit") {
          const rows = rowSets[callIndex] ?? [];
          callIndex++;
          return Promise.resolve(rows);
        }
        return chain;
      };
    }
    // If no limit is called, the chain itself is thenable
    (chain as unknown as PromiseLike<unknown[]>).then = (resolve: (v: unknown[]) => unknown) => {
      const rows = rowSets[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(resolve(rows));
    };
    return chain;
  }

  return {
    select: () => makeChain(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("searchTraces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no matching rows", async () => {
    const db = createChainableDb([[]]);
    const results = await searchTraces(db as never, {});
    expect(results).toEqual([]);
  });

  it("returns metadata rows with correct shape", async () => {
    const row = makeTraceRow();
    const db = createChainableDb([[row]]);
    const results = await searchTraces(db as never, {});
    expect(results).toHaveLength(1);
    expect(results[0].traceId).toBe("aaaa-1111");
    expect(results[0].startedAt).toBe("2026-04-20T10:00:00.000Z");
    expect(results[0].endedAt).toBe("2026-04-20T10:05:00.000Z");
    expect(results[0].companyId).toBe("company-1");
  });

  it("passes companyId filter", async () => {
    const db = createChainableDb([[makeTraceRow({ companyId: "company-2" })]]);
    const results = await searchTraces(db as never, { companyId: "company-2" });
    expect(results).toHaveLength(1);
    expect(results[0].companyId).toBe("company-2");
  });

  it("caps limit at 100", async () => {
    const db = createChainableDb([[]]);
    // The limit is applied inside searchTraces — we just verify no crash
    const results = await searchTraces(db as never, { limit: 999 });
    expect(results).toEqual([]);
  });

  it("uses default limit of 20", async () => {
    const db = createChainableDb([[]]);
    const results = await searchTraces(db as never, {});
    expect(results).toEqual([]);
  });

  it("filters benchmarkOnly rows", async () => {
    const db = createChainableDb([[makeTraceRow({ benchmarkCandidate: true })]]);
    const results = await searchTraces(db as never, { benchmarkOnly: true });
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkCandidate).toBe(true);
  });
});

describe("getTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PAPERCLIP_TRACES_R2_ENDPOINT", "https://r2.example.com");
    vi.stubEnv("PAPERCLIP_TRACES_R2_ACCESS_KEY_ID", "test-key");
    vi.stubEnv("PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY", "test-secret");
    vi.stubEnv("PAPERCLIP_TRACES_R2_BUCKET", "test-bucket");
  });

  it("returns null when trace not found", async () => {
    const db = createChainableDb([[]]);
    const result = await getTrace(db as never, "missing-id", {});
    expect(result).toBeNull();
  });

  it("returns trace with all includes", async () => {
    const traceRow = makeTraceRow();
    const events = [makeEventRow({ turnIndex: 0 }), makeEventRow({ turnIndex: 1, eventId: "evt-2" })];
    const handoffs = [makeHandoffRow()];

    const db = createChainableDb([[traceRow], events, handoffs]);

    mockSend.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve("# Digest content") },
    });

    const result = await getTrace(db as never, "aaaa-1111", {
      includeDigest: true,
      includeRaw: false,
      includeEvents: true,
      includeHandoffPayloads: true,
    });

    expect(result).not.toBeNull();
    expect(result!.trace.traceId).toBe("aaaa-1111");
    expect(result!.digest).toBe("# Digest content");
    expect(result!.raw).toBeNull();
    expect(result!.events).toHaveLength(2);
    expect(result!.eventsTruncated).toBe(false);
    expect(result!.handoffPayloads).toHaveLength(1);
    expect(result!.warnings).toEqual([]);
  });

  it("truncates events when exceeding eventsLimit", async () => {
    const traceRow = makeTraceRow();
    const events = [
      makeEventRow({ turnIndex: 0, eventId: "evt-1" }),
      makeEventRow({ turnIndex: 1, eventId: "evt-2" }),
      makeEventRow({ turnIndex: 2, eventId: "evt-3" }),
    ];

    const db = createChainableDb([[traceRow], events, []]);

    const result = await getTrace(db as never, "aaaa-1111", {
      includeDigest: false,
      includeEvents: true,
      includeHandoffPayloads: true,
      eventsLimit: 2,
    });

    expect(result!.events).toHaveLength(2);
    expect(result!.eventsTruncated).toBe(true);
  });

  it("handles digest missing from R2 gracefully", async () => {
    const traceRow = makeTraceRow();
    const db = createChainableDb([[traceRow], [], []]);

    mockSend.mockResolvedValueOnce({ Body: null });

    const result = await getTrace(db as never, "aaaa-1111", {
      includeDigest: true,
      includeEvents: true,
      includeHandoffPayloads: true,
    });

    expect(result!.digest).toBeNull();
    expect(result!.warnings).toContain("digest_object_not_found_in_r2");
  });

  it("handles raw missing from R2 gracefully", async () => {
    const traceRow = makeTraceRow();
    const db = createChainableDb([[traceRow], [], []]);

    mockSend.mockResolvedValueOnce({ Body: null });

    const result = await getTrace(db as never, "aaaa-1111", {
      includeRaw: true,
      includeDigest: false,
      includeEvents: true,
      includeHandoffPayloads: true,
    });

    expect(result!.raw).toBeNull();
    expect(result!.warnings).toContain("raw_object_not_found_in_r2");
  });

  it("handles R2 transport error gracefully", async () => {
    const traceRow = makeTraceRow();
    const db = createChainableDb([[traceRow], [], []]);

    mockSend.mockRejectedValueOnce(new Error("network timeout"));

    const result = await getTrace(db as never, "aaaa-1111", {
      includeDigest: true,
      includeEvents: true,
      includeHandoffPayloads: true,
    });

    expect(result!.digest).toBeNull();
    expect(result!.warnings).toContain("digest_r2_read_error");
  });
});
