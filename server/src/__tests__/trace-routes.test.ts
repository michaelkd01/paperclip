import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { traceRoutes } from "../routes/traces.js";

// ---------------------------------------------------------------------------
// Mock trace-query service
// ---------------------------------------------------------------------------
const mockSearchTraces = vi.fn();
const mockGetTrace = vi.fn();
vi.mock("../services/trace-query.js", () => ({
  searchTraces: (...args: unknown[]) => mockSearchTraces(...args),
  getTrace: (...args: unknown[]) => mockGetTrace(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createApp(actorOverrides?: Record<string, unknown>) {
  const app = express();
  // Inject a fake actor
  app.use((req, _res, next) => {
    (req as never as Record<string, unknown>).actor = {
      type: "board",
      userId: "local-board",
      isInstanceAdmin: true,
      source: "local_implicit",
      ...actorOverrides,
    };
    next();
  });
  const db = {} as Db;
  app.use(traceRoutes(db));
  return app;
}

const sampleTrace = {
  traceId: "aaaa-1111",
  companyId: "company-1",
  issueId: "issue-1",
  agentId: "agent-1",
  stage: "executor",
  model: "claude-opus-4-6",
  startedAt: "2026-04-20T10:00:00.000Z",
  endedAt: "2026-04-20T10:05:00.000Z",
  durationMs: 300000,
  tokensInTotal: 1000,
  tokensOutTotal: 500,
  outcomeMarker: null,
  parseStatus: "parsed",
  parserVersion: "1.0.0",
  benchmarkCandidate: false,
  r2DigestKey: "digests/key.md",
  r2RawKey: "traces/key.jsonl",
  createdAt: "2026-04-20T10:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /traces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns search results", async () => {
    mockSearchTraces.mockResolvedValue([sampleTrace]);
    const app = createApp();

    const res = await request(app).get("/traces?limit=5");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].traceId).toBe("aaaa-1111");
    expect(mockSearchTraces).toHaveBeenCalledTimes(1);
  });

  it("passes query-string filters to service", async () => {
    mockSearchTraces.mockResolvedValue([]);
    const app = createApp();

    await request(app).get("/traces?companyId=c1&stage=executor&benchmarkOnly=true&limit=10");
    const callArgs = mockSearchTraces.mock.calls[0][1];
    expect(callArgs.companyId).toBe("c1");
    expect(callArgs.stage).toBe("executor");
    expect(callArgs.benchmarkOnly).toBe(true);
    expect(callArgs.limit).toBe(10);
  });

  it("forces companyId for agent-scoped keys", async () => {
    mockSearchTraces.mockResolvedValue([]);
    const app = createApp({
      type: "agent",
      companyId: "agent-company",
      agentId: "a1",
    });

    await request(app).get("/traces?companyId=other-company");
    const callArgs = mockSearchTraces.mock.calls[0][1];
    // Agent-scoped key overrides the companyId from the query string
    expect(callArgs.companyId).toBe("agent-company");
  });
});

describe("GET /traces/:traceId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns trace with all includes", async () => {
    mockGetTrace.mockResolvedValue({
      trace: sampleTrace,
      digest: "# Digest",
      raw: null,
      events: [{ eventId: "e1" }],
      eventsTruncated: false,
      handoffPayloads: [],
      warnings: [],
    });
    const app = createApp();

    const res = await request(app).get("/traces/aaaa-1111?includeEvents=true&includeDigest=true");
    expect(res.status).toBe(200);
    expect(res.body.trace.traceId).toBe("aaaa-1111");
    expect(res.body.digest).toBe("# Digest");
    expect(res.body.events).toHaveLength(1);
  });

  it("returns 404 when trace not found", async () => {
    mockGetTrace.mockResolvedValue(null);
    const app = createApp();

    const res = await request(app).get("/traces/missing-id");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Trace not found");
  });

  it("passes includeRaw flag from query string", async () => {
    mockGetTrace.mockResolvedValue({
      trace: sampleTrace,
      digest: null,
      raw: "raw content",
      events: null,
      eventsTruncated: null,
      handoffPayloads: null,
      warnings: [],
    });
    const app = createApp();

    await request(app).get("/traces/aaaa-1111?includeRaw=true&includeDigest=false&includeEvents=false&includeHandoffPayloads=false");
    const flags = mockGetTrace.mock.calls[0][2];
    expect(flags.includeRaw).toBe(true);
    expect(flags.includeDigest).toBe(false);
    expect(flags.includeEvents).toBe(false);
    expect(flags.includeHandoffPayloads).toBe(false);
  });

  it("passes eventsLimit from query string", async () => {
    mockGetTrace.mockResolvedValue({
      trace: sampleTrace,
      digest: null,
      raw: null,
      events: [],
      eventsTruncated: false,
      handoffPayloads: [],
      warnings: [],
    });
    const app = createApp();

    await request(app).get("/traces/aaaa-1111?eventsLimit=50");
    const flags = mockGetTrace.mock.calls[0][2];
    expect(flags.eventsLimit).toBe(50);
  });
});
