import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { captureTrace } from "../services/trace-capture.js";

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
const mockInsertReturning = vi.fn().mockResolvedValue([{ traceId: "trace-123" }]);
const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
const mockDb = { insert: mockInsert, update: mockUpdate } as any;

function makeArgs(model: string | null) {
  return {
    db: mockDb,
    runId: "run-model-guard",
    companyId: "co-1",
    issueId: "issue-1",
    agentId: "agent-1",
    agentRole: "executor",
    model,
    sessionId: "sess-model-guard",
    startedAt: new Date("2025-01-01T00:00:00Z"),
    endedAt: new Date("2025-01-01T00:01:00Z"),
    tokensInTotal: 100,
    tokensOutTotal: 200,
    outcomeMarker: "success",
    adapterCwd: "/test/cwd",
  };
}

describe("captureTrace model guard", () => {
  let tmpDir: string;
  let envBackup: NodeJS.ProcessEnv;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-model-guard-"));

    // Mock os.homedir so resolveSessionTranscript looks in our tmpDir
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);

    // Set up R2 env vars
    envBackup = { ...process.env };
    process.env.PAPERCLIP_TRACES_R2_ENDPOINT = "https://fake-r2.example.com";
    process.env.PAPERCLIP_TRACES_R2_ACCESS_KEY_ID = "fake-key";
    process.env.PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY = "fake-secret";
    process.env.PAPERCLIP_TRACES_R2_BUCKET = "fake-bucket";

    // Reset mocks
    mockSend.mockClear();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockClear();
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();

    // Spy on console.log to capture structured log lines
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = envBackup;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Test 1: Skip on non-Claude model
  it("skips capture when model is gpt-5.3-codex", async () => {
    const result = await captureTrace(makeArgs("gpt-5.3-codex"));

    // No R2 upload
    expect(mockSend).not.toHaveBeenCalled();
    // No DB insert
    expect(mockInsert).not.toHaveBeenCalled();
    // Function returns without throwing
    expect(result).toBeDefined();
  });

  // Test 2: Skip on other non-Claude models (parameterised)
  it.each(["gpt-4o", "gpt-5.3-codex", "o3-mini", "gemini-1.5-pro"])(
    "skips capture for non-Claude model: %s",
    async (model) => {
      const result = await captureTrace(makeArgs(model));

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    },
  );

  // Test 3 & 4: Proceed for claude-family models (parameterised)
  it.each(["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"])(
    "does NOT skip for Claude model: %s",
    async (model) => {
      // Set up the session transcript file so capture can proceed
      const slug = "/test/cwd".replace(/\//g, "-"); // "-test-cwd"
      const projectDir = path.join(tmpDir, ".claude", "projects", slug);
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, "sess-model-guard.jsonl"),
        '{"msg":"hello"}\n',
      );

      const result = await captureTrace(makeArgs(model));

      // The model guard returns { warnings: ["non_claude_model_skipped"] }.
      // Assert that the guard did NOT fire for Claude models.
      expect(result.warnings).not.toContain("non_claude_model_skipped");
    },
  );

  // Test 5: Skip is observable via structured log
  it("emits a structured log line when skipping non-Claude model", async () => {
    await captureTrace(makeArgs("gpt-5.3-codex"));

    // Find the log call that contains the skip event
    const logCalls = consoleLogSpy.mock.calls.map((call) => {
      try {
        return JSON.parse(call[0] as string);
      } catch {
        return null;
      }
    }).filter(Boolean);

    const skipLog = logCalls.find(
      (entry: any) => entry.event === "trace_capture_skipped_non_claude_model",
    );

    expect(skipLog).toBeDefined();
    expect(skipLog.runId).toBe("run-model-guard");
    expect(skipLog.agentId).toBe("agent-1");
    expect(skipLog.model).toBe("gpt-5.3-codex");
  });
});
