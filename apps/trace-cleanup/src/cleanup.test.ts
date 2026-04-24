import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, type CleanupOptions } from "./cleanup.js";
import type { ExpiredTrace, HandoffPayloadRow } from "./db.js";

// ── Mock DB module ──────────────────────────────────────────────────────────

const mockFetchExpiredTraces = vi.fn<() => Promise<ExpiredTrace[]>>();
const mockDeleteTraceEventsForTrace = vi.fn<(db: unknown, traceId: string) => Promise<number>>();
const mockFetchHandoffPayloadsForTrace = vi.fn<(db: unknown, traceId: string) => Promise<HandoffPayloadRow[]>>();
const mockDeleteHandoffPayload = vi.fn<(db: unknown, payloadId: string) => Promise<void>>();
const mockNullifyTraceR2Keys = vi.fn<(db: unknown, traceId: string) => Promise<void>>();

vi.mock("./db.js", () => ({
  fetchExpiredTraces: (...args: unknown[]) => mockFetchExpiredTraces(...args as []),
  deleteTraceEventsForTrace: (...args: unknown[]) => mockDeleteTraceEventsForTrace(...(args as [unknown, string])),
  fetchHandoffPayloadsForTrace: (...args: unknown[]) => mockFetchHandoffPayloadsForTrace(...(args as [unknown, string])),
  deleteHandoffPayload: (...args: unknown[]) => mockDeleteHandoffPayload(...(args as [unknown, string])),
  nullifyTraceR2Keys: (...args: unknown[]) => mockNullifyTraceR2Keys(...(args as [unknown, string])),
  createDb: vi.fn(),
}));

// ── Mock R2 ─────────────────────────────────────────────────────────────────

let deletedR2Keys: string[];

function createMockR2Client() {
  return {
    send: vi.fn().mockImplementation((cmd: { input?: { Bucket?: string; Key?: string } }) => {
      const key = cmd.input?.Key;
      if (key) deletedR2Keys.push(key);
      return Promise.resolve({});
    }),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

const fakeDb = {} as CleanupOptions["db"];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deletedR2Keys = [];
    mockDeleteTraceEventsForTrace.mockResolvedValue(0);
    mockFetchHandoffPayloadsForTrace.mockResolvedValue([]);
    mockDeleteHandoffPayload.mockResolvedValue(undefined);
    mockNullifyTraceR2Keys.mockResolvedValue(undefined);
  });

  it("identifies expired traces", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "old-1", r2RawKey: "raw/old-1.jsonl", r2DigestKey: "raw/old-1.digest.md" },
      { traceId: "old-2", r2RawKey: "raw/old-2.jsonl", r2DigestKey: null },
    ]);
    mockDeleteTraceEventsForTrace.mockResolvedValue(1);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.tracesCleaned).toBe(2);
  });

  it("skips benchmark candidates", async () => {
    // fetchExpiredTraces already filters them out in the SQL query,
    // so returning empty means none are expired non-benchmark
    mockFetchExpiredTraces.mockResolvedValue([]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.tracesCleaned).toBe(0);
    expect(r2.send).not.toHaveBeenCalled();
  });

  it("skips recent traces", async () => {
    // fetchExpiredTraces filters by age in the SQL query,
    // so returning empty means none are old enough
    mockFetchExpiredTraces.mockResolvedValue([]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.tracesCleaned).toBe(0);
    expect(r2.send).not.toHaveBeenCalled();
  });

  it("deletes R2 objects", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "old-r2", r2RawKey: "raw/old-r2.jsonl", r2DigestKey: "raw/old-r2.digest.md" },
    ]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.r2ObjectsDeleted).toBe(2);
    expect(deletedR2Keys).toContain("raw/old-r2.jsonl");
    expect(deletedR2Keys).toContain("raw/old-r2.digest.md");
  });

  it("deletes trace_events rows", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "old-ev", r2RawKey: "raw/old-ev.jsonl", r2DigestKey: null },
    ]);
    mockDeleteTraceEventsForTrace.mockResolvedValue(5);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.eventsDeleted).toBe(5);
    expect(mockDeleteTraceEventsForTrace).toHaveBeenCalledWith(fakeDb, "old-ev");
  });

  it("deletes handoff_payloads with R2 keys", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "old-hp", r2RawKey: "raw/old-hp.jsonl", r2DigestKey: null },
    ]);
    mockFetchHandoffPayloadsForTrace.mockResolvedValue([
      { payloadId: "hp1", producerTraceId: "old-hp", consumerTraceId: null, payloadR2Key: "payloads/hp1.json" },
      { payloadId: "hp2", producerTraceId: "other", consumerTraceId: "old-hp", payloadR2Key: null },
    ]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.handoffPayloadsDeleted).toBe(2);
    expect(deletedR2Keys).toContain("payloads/hp1.json");
    expect(mockDeleteHandoffPayload).toHaveBeenCalledWith(fakeDb, "hp1");
    expect(mockDeleteHandoffPayload).toHaveBeenCalledWith(fakeDb, "hp2");
  });

  it("preserves traces metadata shell", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "old-shell", r2RawKey: "raw/old-shell.jsonl", r2DigestKey: "raw/old-shell.digest.md" },
    ]);

    const r2 = createMockR2Client();
    await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    // The trace row should have R2 keys nullified (not deleted)
    expect(mockNullifyTraceR2Keys).toHaveBeenCalledWith(fakeDb, "old-shell");
  });

  it("dry-run mode makes no changes", async () => {
    mockFetchExpiredTraces.mockResolvedValue([
      { traceId: "dry-1", r2RawKey: "raw/dry-1.jsonl", r2DigestKey: "raw/dry-1.digest.md" },
    ]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: true,
    });

    // Should report candidates found
    expect(result.tracesCleaned).toBeGreaterThan(0);
    // But no actual deletions
    expect(deletedR2Keys).toHaveLength(0);
    expect(mockDeleteTraceEventsForTrace).not.toHaveBeenCalled();
    expect(mockDeleteHandoffPayload).not.toHaveBeenCalled();
    expect(mockNullifyTraceR2Keys).not.toHaveBeenCalled();
  });

  it("empty result set completes cleanly", async () => {
    mockFetchExpiredTraces.mockResolvedValue([]);

    const r2 = createMockR2Client();
    const result = await cleanup({
      db: fakeDb,
      r2Client: r2 as unknown as CleanupOptions["r2Client"],
      r2Bucket: "test-bucket",
      dryRun: false,
    });

    expect(result.tracesCleaned).toBe(0);
    expect(result.eventsDeleted).toBe(0);
    expect(result.r2ObjectsDeleted).toBe(0);
    expect(result.handoffPayloadsDeleted).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
