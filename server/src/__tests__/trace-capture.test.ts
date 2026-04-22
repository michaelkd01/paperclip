import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { captureTrace, mapRoleToStage, type CaptureTraceArgs } from "../services/trace-capture.js";

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-s3
// ---------------------------------------------------------------------------
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
const mockStat = vi.fn();
const mockReaddir = vi.fn();
const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: {
    stat: (...args: unknown[]) => mockStat(...args),
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  },
}));

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------
function createMockDb() {
  const insertReturning = vi.fn().mockResolvedValue([{ traceId: "trace-uuid-1" }]);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue([]);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  return {
    insert: insertFn,
    update: updateFn,
    _mocks: { insertFn, insertValues, insertReturning, updateFn, updateSet, updateWhere },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function baseArgs(overrides?: Partial<CaptureTraceArgs>): CaptureTraceArgs {
  return {
    db: createMockDb() as unknown as CaptureTraceArgs["db"],
    runId: "run-1",
    companyId: "company-1",
    issueId: "issue-1",
    agentId: "agent-1",
    agentRole: "executor",
    model: "claude-opus-4-6",
    sessionId: "sess-abc",
    startedAt: new Date("2026-04-22T10:00:00Z"),
    endedAt: new Date("2026-04-22T10:05:00Z"),
    tokensInTotal: 1000,
    tokensOutTotal: 500,
    outcomeMarker: null,
    adapterCwd: "/Users/test/project",
    ...overrides,
  };
}

/**
 * Set up mocks for the happy path: session transcript found via direct path.
 * Call this only when the test expects transcript resolution to succeed.
 */
function setupDirectPathMocks(opts?: { fileContent?: string }) {
  const content = opts?.fileContent ?? '{"type":"init"}\n{"type":"result"}\n';
  // fs.stat for direct path → success
  mockStat.mockResolvedValueOnce({ size: 100 });
  // fs.readFile for transcript content
  mockReadFile.mockResolvedValueOnce(content);
}

// ---------------------------------------------------------------------------
// Set up R2 env vars
// ---------------------------------------------------------------------------
const R2_ENV = {
  PAPERCLIP_TRACES_R2_ENDPOINT: "https://r2.example.com",
  PAPERCLIP_TRACES_R2_ACCESS_KEY_ID: "key",
  PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY: "secret",
  PAPERCLIP_TRACES_R2_BUCKET: "paperclip-traces",
};

describe("mapRoleToStage", () => {
  it("maps all seven known roles", () => {
    expect(mapRoleToStage("pre-planner")).toBe("pre-planner");
    expect(mapRoleToStage("executor")).toBe("executor");
    expect(mapRoleToStage("test")).toBe("test");
    expect(mapRoleToStage("ux-verifier")).toBe("ux-verifier");
    expect(mapRoleToStage("supervisor")).toBe("supervisor");
    expect(mapRoleToStage("conductor")).toBe("conductor");
    expect(mapRoleToStage("ceo")).toBe("ceo");
  });

  it("returns null for unknown roles", () => {
    expect(mapRoleToStage("pm")).toBeNull();
    expect(mapRoleToStage("general")).toBeNull();
    expect(mapRoleToStage(null)).toBeNull();
    expect(mapRoleToStage("")).toBeNull();
  });
});

describe("captureTrace", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockStat.mockReset();
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockSend.mockReset();
    Object.assign(process.env, R2_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(R2_ENV)) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("test_capture_success", async () => {
    setupDirectPathMocks();
    mockSend.mockResolvedValueOnce({});

    const args = baseArgs();
    const result = await captureTrace(args);

    expect(result.traceId).toBe("trace-uuid-1");
    expect(result.r2RawKey).toBe("traces/company-1/issue-1/executor/run-1.jsonl");
    expect(result.warnings).toEqual([]);

    const mockDb = args.db as unknown as ReturnType<typeof createMockDb>;
    expect(mockDb._mocks.insertFn).toHaveBeenCalledTimes(1);
    expect(mockDb._mocks.updateFn).toHaveBeenCalledTimes(1);
  });

  it("test_capture_missing_transcript", async () => {
    // sessionId=null, adapterCwd=null → only mtime scan runs
    // readdir for projects dir returns empty → no files to scan
    mockReaddir.mockResolvedValueOnce([]);

    const args = baseArgs({ sessionId: null, adapterCwd: null });
    const result = await captureTrace(args);

    expect(result.traceId).toBeNull();
    expect(result.r2RawKey).toBeNull();
    expect(result.warnings).toContain("session_transcript_not_found");

    const mockDb = args.db as unknown as ReturnType<typeof createMockDb>;
    expect(mockDb._mocks.insertFn).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("test_capture_malformed_jsonl", async () => {
    setupDirectPathMocks({ fileContent: '{"valid":true}\nNOT_JSON\n{"also":true}\n' });
    mockSend.mockResolvedValueOnce({});

    const args = baseArgs();
    const result = await captureTrace(args);

    expect(result.traceId).toBe("trace-uuid-1");
    expect(result.r2RawKey).toBe("traces/company-1/issue-1/executor/run-1.jsonl");
    expect(result.warnings).toContain("malformed_jsonl_line_2");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("test_capture_r2_outage", async () => {
    setupDirectPathMocks();
    mockSend.mockRejectedValueOnce(new Error("R2 connection refused"));

    const args = baseArgs();
    const result = await captureTrace(args);

    expect(result.traceId).toBeNull();
    expect(result.r2RawKey).toBeNull();
    expect(result.warnings).toContain("R2 connection refused");

    const mockDb = args.db as unknown as ReturnType<typeof createMockDb>;
    expect(mockDb._mocks.insertFn).not.toHaveBeenCalled();
  });

  it("test_capture_db_error", async () => {
    setupDirectPathMocks();
    mockSend.mockResolvedValueOnce({});

    const args = baseArgs();
    const mockDb = args.db as unknown as ReturnType<typeof createMockDb>;
    mockDb._mocks.insertReturning.mockRejectedValueOnce(new Error("DB connection lost"));

    const result = await captureTrace(args);

    expect(result.traceId).toBeNull();
    expect(result.r2RawKey).toBeNull();
    expect(result.warnings).toContain("DB connection lost");
  });

  it("test_capture_no_issue_id", async () => {
    const args = baseArgs({ issueId: null });
    const result = await captureTrace(args);

    expect(result.traceId).toBeNull();
    expect(result.r2RawKey).toBeNull();
    expect(result.warnings).toContain("no_issue_id_run_skipped");

    const mockDb = args.db as unknown as ReturnType<typeof createMockDb>;
    expect(mockDb._mocks.insertFn).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("test_capture_r2_credentials_missing", async () => {
    delete process.env.PAPERCLIP_TRACES_R2_ENDPOINT;
    delete process.env.PAPERCLIP_TRACES_R2_ACCESS_KEY_ID;

    setupDirectPathMocks();

    const args = baseArgs();
    const result = await captureTrace(args);

    expect(result.traceId).toBeNull();
    expect(result.r2RawKey).toBeNull();
    expect(result.warnings).toContain("r2_credentials_missing");
  });
});
