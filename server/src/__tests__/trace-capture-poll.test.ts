import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * ADR-004-3a: Tests for transcript-flush race fix.
 *
 * We test the new `locateTranscript` polling function and the existing
 * `captureTrace` integration with it.
 */

import { locateTranscript, captureTrace } from "../services/trace-capture.js";

// Module-level S3 mock — vi.mock is hoisted so this must be at top level
const mockSend = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

describe("locateTranscript (poll with exponential backoff)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-poll-test-"));
    mockSend.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves immediately when the JSONL file exists on first attempt", async () => {
    const sessionId = "sess-immediate";
    const projectDir = path.join(tmpDir, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, '{"msg":"hello"}\n');

    const result = await locateTranscript(sessionId, projectDir);
    expect(result).toBe(filePath);
  });

  it("resolves after the file appears with a delay", async () => {
    const sessionId = "sess-delayed";
    const projectDir = path.join(tmpDir, "proj");
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);

    // Create file after 2 seconds
    setTimeout(async () => {
      await fs.writeFile(filePath, '{"msg":"hello"}\n');
    }, 2000);

    const result = await locateTranscript(sessionId, projectDir);
    expect(result).toBe(filePath);
  }, 20_000);

  it("returns null after exhausting retries when file never appears", async () => {
    const sessionId = "sess-missing";
    const projectDir = path.join(tmpDir, "proj");
    await fs.mkdir(projectDir, { recursive: true });

    const result = await locateTranscript(sessionId, projectDir);
    expect(result).toBeNull();
  }, 35_000);

  it("uses exponential backoff timing", async () => {
    const sessionId = "sess-backoff";
    const projectDir = path.join(tmpDir, "proj");
    await fs.mkdir(projectDir, { recursive: true });

    // Track the intervals between retries by spying on fs.stat
    const timestamps: number[] = [];
    const originalStat = fs.stat;
    const spy = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      timestamps.push(Date.now());
      // Always throw to force retries — file never exists
      throw new Error("ENOENT");
    });

    await locateTranscript(sessionId, projectDir);

    spy.mockRestore();

    // We expect 6 calls total (1 initial + 5 retries)
    expect(timestamps.length).toBe(6);

    // Check intervals increase exponentially: ~500, ~1000, ~2000, ~4000, ~8000
    const intervals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }

    // Expected intervals: 500, 1000, 2000, 4000, 8000
    const expectedIntervals = [500, 1000, 2000, 4000, 8000];
    for (let i = 0; i < expectedIntervals.length; i++) {
      // Allow 200ms tolerance for timer jitter
      expect(intervals[i]).toBeGreaterThan(expectedIntervals[i] - 200);
      expect(intervals[i]).toBeLessThan(expectedIntervals[i] + 500);
    }
  }, 35_000);

  it("captureTrace calls R2 upload and DB write when transcript is found", async () => {
    const sessionId = "sess-integration";
    // Build the directory structure that resolveSessionTranscript expects:
    // <homedir>/.claude/projects/<slug>/<sessionId>.jsonl
    // We use adapterCwd = "/test/cwd" → slug = "-test-cwd"
    const adapterCwd = "/test/cwd";
    const slug = adapterCwd.replace(/\//g, "-"); // "-test-cwd"
    const fakeHome = tmpDir;
    const projectDir = path.join(fakeHome, ".claude", "projects", slug);
    await fs.mkdir(projectDir, { recursive: true });
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    await fs.writeFile(filePath, '{"msg":"hello"}\n');

    // Mock os.homedir to return our tmpDir
    const originalHomedir = os.homedir;
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);

    // Mock R2 env vars
    const envBackup = { ...process.env };
    process.env.PAPERCLIP_TRACES_R2_ENDPOINT = "https://fake-r2.example.com";
    process.env.PAPERCLIP_TRACES_R2_ACCESS_KEY_ID = "fake-key";
    process.env.PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY = "fake-secret";
    process.env.PAPERCLIP_TRACES_R2_BUCKET = "fake-bucket";

    // S3Client is mocked at the top level via vi.mock hoisting.
    // Access mockSend via the module-scoped variable.

    // Mock DB
    const mockInsertReturning = vi.fn().mockResolvedValue([{ traceId: "trace-123" }]);
    const mockInsertValues = vi.fn().mockReturnValue({ returning: mockInsertReturning });
    const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
    const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
    const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
    const mockDb = { insert: mockInsert, update: mockUpdate } as any;

    const result = await captureTrace({
      db: mockDb,
      runId: "run-1",
      companyId: "co-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentRole: "executor",
      model: "claude-sonnet-4-20250514",
      sessionId,
      startedAt: new Date("2025-01-01T00:00:00Z"),
      endedAt: new Date("2025-01-01T00:01:00Z"),
      tokensInTotal: 100,
      tokensOutTotal: 200,
      outcomeMarker: "success",
      adapterCwd,
    });

    expect(result.traceId).toBe("trace-123");
    expect(result.r2RawKey).toContain("run-1.jsonl");
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    // Restore
    vi.restoreAllMocks();
    process.env = envBackup;
  }, 20_000);
});
