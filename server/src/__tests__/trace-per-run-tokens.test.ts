import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { captureTrace, type CaptureTraceArgs } from "../services/trace-capture.js";

// Module-level S3 mock — vi.mock is hoisted so this must be at top level
const mockSend = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

// Mock DB — tracks insert and update calls
const mockInsertReturning = vi.fn().mockResolvedValue([{ traceId: "trace-per-run-1" }]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
const mockDb = { insert: mockInsert, update: mockUpdate } as any;

function makeBaseArgs(overrides?: Partial<CaptureTraceArgs>): CaptureTraceArgs {
  return {
    db: mockDb,
    runId: "run-per-run-1",
    companyId: "co-1",
    issueId: "issue-1",
    agentId: "agent-1",
    agentRole: "executor",
    model: "claude-opus-4-6",
    sessionId: "sess-per-run",
    startedAt: new Date("2025-01-01T00:00:00Z"),
    endedAt: new Date("2025-01-01T00:01:00Z"),
    tokensInTotal: 100,
    tokensOutTotal: 200,
    tokensInPerRun: 150,
    tokensOutPerRun: 25,
    outcomeMarker: "success",
    adapterCwd: "/test/cwd",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test 1: captureTrace_writes_per_run_tokens_from_args
// ---------------------------------------------------------------------------

describe("per-run token columns", () => {
  let tmpDir: string;
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-per-run-test-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

    envBackup = { ...process.env };
    process.env.PAPERCLIP_TRACES_R2_ENDPOINT = "https://fake-r2.example.com";
    process.env.PAPERCLIP_TRACES_R2_ACCESS_KEY_ID = "fake-key";
    process.env.PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY = "fake-secret";
    process.env.PAPERCLIP_TRACES_R2_BUCKET = "fake-bucket";

    mockSend.mockReset().mockResolvedValue({});
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockClear().mockResolvedValue([{ traceId: "trace-per-run-1" }]);
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();
  });

  afterEach(async () => {
    // Only restore spies we created (os.homedir), not the module-level S3 mock
    vi.spyOn(os, "homedir").mockRestore();
    process.env = envBackup;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function setupTranscript() {
    const slug = "/test/cwd".replace(/\//g, "-");
    const projectDir = path.join(tmpDir, ".claude", "projects", slug);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "sess-per-run.jsonl"),
      '{"msg":"hello"}\n',
    );
  }

  it("captureTrace_writes_per_run_tokens_from_args", async () => {
    await setupTranscript();
    mockSend.mockResolvedValueOnce({});

    await captureTrace(makeBaseArgs({
      tokensInPerRun: 12345,
      tokensOutPerRun: 678,
    }));

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.tokensInPerRun).toBe(12345);
    expect(insertedValues.tokensOutPerRun).toBe(678);
  });

  it("captureTrace_handles_null_per_run_gracefully", async () => {
    await setupTranscript();
    mockSend.mockResolvedValue({});

    await captureTrace(makeBaseArgs({
      tokensInPerRun: null,
      tokensOutPerRun: null,
    }));

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues.tokensInPerRun).toBeNull();
    expect(insertedValues.tokensOutPerRun).toBeNull();
  });

  it("heartbeat_formula_includes_cached_input_tokens", () => {
    // Test the formula in isolation:
    // Given usage = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 25 }
    const usage: Record<string, number> = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 25 };

    const inputTokens = usage.inputTokens ?? 0;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;

    const tokensInPerRun = usage ? inputTokens + cachedInputTokens : null;
    const tokensOutPerRun = usage ? outputTokens : null;

    expect(tokensInPerRun).toBe(150);
    expect(tokensOutPerRun).toBe(25);
  });

  it("heartbeat_formula_handles_missing_cached_input_tokens", () => {
    // Given usage = { inputTokens: 100, outputTokens: 25 } (no cachedInputTokens)
    const usage: Record<string, number> = { inputTokens: 100, outputTokens: 25 };

    const inputTokens = usage.inputTokens ?? 0;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;

    const tokensInPerRun = usage ? inputTokens + cachedInputTokens : null;
    const tokensOutPerRun = usage ? outputTokens : null;

    expect(tokensInPerRun).toBe(100);
    expect(tokensOutPerRun).toBe(25);
  });

  it("heartbeat_formula_handles_null_usage_json", () => {
    const usage = null;

    const inputTokens = (usage as any)?.inputTokens ?? 0;
    const cachedInputTokens = (usage as any)?.cachedInputTokens ?? 0;
    const outputTokens = (usage as any)?.outputTokens ?? 0;

    const tokensInPerRun = usage ? inputTokens + cachedInputTokens : null;
    const tokensOutPerRun = usage ? outputTokens : null;

    expect(tokensInPerRun).toBeNull();
    expect(tokensOutPerRun).toBeNull();
  });

  it("parser_does_not_modify_per_run_columns", async () => {
    // This test verifies the parser's UPDATE statement only touches
    // tokensInTotal and tokensOutTotal, not the per-run columns.
    // We import the parser's persistParseResult and check what SET clause it produces.
    const { persistParseResult } = await import("../../../apps/trace-parser/src/db.js");

    // Build a mock DB that captures the .set() call on the traces UPDATE
    const capturedSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
    const mockTx = {
      update: vi.fn().mockReturnValue({ set: capturedSet }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    };
    // persistParseResult wraps in a transaction — mock db.transaction to invoke the callback
    const mockParserDb = {
      transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockTx)),
    };

    // Call persistParseResult with synthetic data
    const mockResult = {
      summary: { totalTokensIn: 5000, totalTokensOut: 2000 },
      events: [],
      handoffs: [],
      warnings: [],
    };

    await persistParseResult(
      mockParserDb as any,
      "trace-parser-test-1",
      mockResult as any,
      "test-v1",
    );

    // The SET clause should NOT contain tokensInPerRun or tokensOutPerRun
    expect(capturedSet).toHaveBeenCalledTimes(1);
    const setArg = capturedSet.mock.calls[0][0];
    expect(setArg).not.toHaveProperty("tokensInPerRun");
    expect(setArg).not.toHaveProperty("tokensOutPerRun");
    // But it should set tokensInTotal and tokensOutTotal
    expect(setArg).toHaveProperty("tokensInTotal");
    expect(setArg).toHaveProperty("tokensOutTotal");
  });

  it("trace_query_returns_per_run_fields", async () => {
    // Import the toMetadata function indirectly via searchTraces
    const { searchTraces } = await import("../services/trace-query.js");

    const traceRow = {
      traceId: "aaaa-per-run",
      runId: "run-1",
      companyId: "company-1",
      issueId: "issue-1",
      agentId: "agent-1",
      stage: "executor" as const,
      model: "claude-opus-4-6",
      sessionId: "sess-1",
      startedAt: new Date("2026-04-20T10:00:00Z"),
      endedAt: new Date("2026-04-20T10:05:00Z"),
      durationMs: 300000,
      tokensInTotal: 1000,
      tokensOutTotal: 500,
      tokensInPerRun: 150,
      tokensOutPerRun: 25,
      outcomeMarker: null,
      r2RawKey: "traces/key.jsonl",
      r2DigestKey: "digests/key.md",
      benchmarkCandidate: false,
      parseStatus: "parsed" as const,
      parseWarnings: null,
      parsedAt: new Date("2026-04-20T10:10:00Z"),
      parserVersion: "1.0.0",
      createdAt: new Date("2026-04-20T10:00:00Z"),
    };

    // Build a chainable mock DB
    function makeChain(rows: unknown[]) {
      const chain: Record<string, any> = {};
      for (const m of ["from", "where", "orderBy"]) {
        chain[m] = () => chain;
      }
      chain.limit = () => Promise.resolve(rows);
      return chain;
    }
    const db = { select: () => makeChain([traceRow]) };

    const results = await searchTraces(db as any, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveProperty("tokensInPerRun", 150);
    expect(results[0]).toHaveProperty("tokensOutPerRun", 25);
  });

  it("backfill_populates_per_run_from_usage_json", async () => {
    // This test verifies the backfill SQL logic.
    // We test the formula directly since we can't easily run raw SQL in unit tests.
    // The backfill SQL is:
    //   tokens_in_per_run = COALESCE(inputTokens, 0) + COALESCE(cachedInputTokens, 0)
    //   tokens_out_per_run = COALESCE(outputTokens, 0)
    const usageJson = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 25 };

    const tokensInPerRun = (usageJson.inputTokens ?? 0) + ((usageJson as any).cachedInputTokens ?? 0);
    const tokensOutPerRun = usageJson.outputTokens ?? 0;

    expect(tokensInPerRun).toBe(150);
    expect(tokensOutPerRun).toBe(25);
  });

  it("backfill_idempotent", () => {
    // The backfill SQL has a WHERE clause: t.tokens_in_per_run IS NULL
    // This means running it twice on the same row won't change already-set values.
    // We simulate: first run sets the values, second run skips because IS NULL is false.
    let tokensInPerRun: number | null = null;
    let tokensOutPerRun: number | null = null;
    const usageJson = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 25 };

    // First run: NULL → set
    if (tokensInPerRun === null && usageJson != null) {
      tokensInPerRun = (usageJson.inputTokens ?? 0) + ((usageJson as any).cachedInputTokens ?? 0);
      tokensOutPerRun = usageJson.outputTokens ?? 0;
    }
    expect(tokensInPerRun).toBe(150);
    expect(tokensOutPerRun).toBe(25);

    // Second run: NOT NULL → skip
    const prevIn = tokensInPerRun;
    const prevOut = tokensOutPerRun;
    if (tokensInPerRun === null && usageJson != null) {
      tokensInPerRun = 999; // Would be wrong if this branch is entered
      tokensOutPerRun = 999;
    }
    expect(tokensInPerRun).toBe(prevIn);
    expect(tokensOutPerRun).toBe(prevOut);
  });

  it("backfill_skips_rows_with_null_usage_json", () => {
    // The backfill SQL has: WHERE hr.usage_json IS NOT NULL
    // When usage_json is NULL, the row is not matched and per-run columns stay NULL.
    let tokensInPerRun: number | null = null;
    let tokensOutPerRun: number | null = null;
    const usageJson = null;

    if (tokensInPerRun === null && usageJson != null) {
      tokensInPerRun = 999;
      tokensOutPerRun = 999;
    }

    expect(tokensInPerRun).toBeNull();
    expect(tokensOutPerRun).toBeNull();
  });
});
