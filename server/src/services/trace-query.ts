import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Db } from "@paperclipai/db";
import { traces, traceEvents, handoffPayloads } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceSearchFilters {
  companyId?: string;
  issueId?: string;
  stage?: string;
  agentId?: string;
  outcomeMarker?: string;
  from?: string;
  to?: string;
  parseStatus?: string;
  benchmarkOnly?: boolean;
  limit?: number;
}

export interface TraceGetFlags {
  includeRaw?: boolean;
  includeDigest?: boolean;
  includeEvents?: boolean;
  includeHandoffPayloads?: boolean;
  eventsLimit?: number;
}

export interface TraceMetadata {
  traceId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  stage: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  tokensInTotal: number | null;
  tokensOutTotal: number | null;
  tokensInPerRun: number | null;
  tokensOutPerRun: number | null;
  outcomeMarker: string | null;
  parseStatus: string;
  parserVersion: string | null;
  benchmarkCandidate: boolean;
  r2DigestKey: string | null;
  r2RawKey: string | null;
  createdAt: string;
}

export interface TraceGetResult {
  trace: TraceMetadata;
  digest: string | null;
  raw: string | null;
  events: unknown[] | null;
  eventsTruncated: boolean | null;
  handoffPayloads: unknown[] | null;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// R2 helper (read-only)
// ---------------------------------------------------------------------------

function buildR2ReadClient(): { client: S3Client; bucket: string } | null {
  const endpoint = process.env.PAPERCLIP_TRACES_R2_ENDPOINT;
  const accessKeyId = process.env.PAPERCLIP_TRACES_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PAPERCLIP_TRACES_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.PAPERCLIP_TRACES_R2_BUCKET;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }

  const client = new S3Client({
    endpoint,
    region: "auto",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  return { client, bucket };
}

async function fetchR2Object(key: string): Promise<string | null> {
  const r2 = buildR2ReadClient();
  if (!r2) return null;

  const response = await r2.client.send(
    new GetObjectCommand({ Bucket: r2.bucket, Key: key }),
  );
  if (!response.Body) return null;
  return response.Body.transformToString("utf-8");
}

// ---------------------------------------------------------------------------
// Row → metadata shape
// ---------------------------------------------------------------------------

function toMetadata(row: typeof traces.$inferSelect): TraceMetadata {
  return {
    traceId: row.traceId,
    companyId: row.companyId,
    issueId: row.issueId,
    agentId: row.agentId,
    stage: row.stage,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMs: row.durationMs,
    tokensInTotal: row.tokensInTotal,
    tokensOutTotal: row.tokensOutTotal,
    tokensInPerRun: row.tokensInPerRun,
    tokensOutPerRun: row.tokensOutPerRun,
    outcomeMarker: row.outcomeMarker,
    parseStatus: row.parseStatus,
    parserVersion: row.parserVersion,
    benchmarkCandidate: row.benchmarkCandidate,
    r2DigestKey: row.r2DigestKey,
    r2RawKey: row.r2RawKey,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// searchTraces
// ---------------------------------------------------------------------------

export async function searchTraces(
  db: Db,
  filters: TraceSearchFilters,
): Promise<TraceMetadata[]> {
  const conditions = [];

  if (filters.companyId) {
    conditions.push(eq(traces.companyId, filters.companyId));
  }
  if (filters.issueId) {
    conditions.push(eq(traces.issueId, filters.issueId));
  }
  if (filters.stage) {
    conditions.push(sql`${traces.stage} = ${filters.stage}`);
  }
  if (filters.agentId) {
    conditions.push(eq(traces.agentId, filters.agentId));
  }
  if (filters.outcomeMarker) {
    conditions.push(eq(traces.outcomeMarker, filters.outcomeMarker));
  }
  if (filters.from) {
    conditions.push(gte(traces.createdAt, new Date(filters.from)));
  }
  if (filters.to) {
    conditions.push(lte(traces.createdAt, new Date(filters.to)));
  }
  if (filters.parseStatus) {
    conditions.push(sql`${traces.parseStatus} = ${filters.parseStatus}`);
  }
  if (filters.benchmarkOnly) {
    conditions.push(eq(traces.benchmarkCandidate, true));
  }

  const effectiveLimit = Math.min(Math.max(filters.limit ?? 20, 1), 100);

  const rows = await db
    .select()
    .from(traces)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(traces.createdAt))
    .limit(effectiveLimit);

  return rows.map(toMetadata);
}

// ---------------------------------------------------------------------------
// getTrace
// ---------------------------------------------------------------------------

export async function getTrace(
  db: Db,
  traceId: string,
  flags: TraceGetFlags = {},
): Promise<TraceGetResult | null> {
  const {
    includeRaw = false,
    includeDigest = true,
    includeEvents = true,
    includeHandoffPayloads: includeHandoffs = true,
    eventsLimit = 500,
  } = flags;

  const effectiveEventsLimit = Math.min(Math.max(eventsLimit, 1), 5000);
  const warnings: string[] = [];

  // 1. Fetch trace row
  const [row] = await db
    .select()
    .from(traces)
    .where(eq(traces.traceId, traceId));

  if (!row) return null;

  const trace = toMetadata(row);

  // 2. Digest from R2
  let digest: string | null = null;
  if (includeDigest && row.r2DigestKey) {
    try {
      digest = await fetchR2Object(row.r2DigestKey);
      if (digest === null) {
        warnings.push("digest_object_not_found_in_r2");
      }
    } catch {
      digest = null;
      warnings.push("digest_r2_read_error");
    }
  }

  // 3. Raw from R2
  let raw: string | null = null;
  if (includeRaw && row.r2RawKey) {
    try {
      raw = await fetchR2Object(row.r2RawKey);
      if (raw === null) {
        warnings.push("raw_object_not_found_in_r2");
      }
    } catch {
      raw = null;
      warnings.push("raw_r2_read_error");
    }
  }

  // 4. Events
  let events: unknown[] | null = null;
  let eventsTruncated: boolean | null = null;
  if (includeEvents) {
    const eventRows = await db
      .select()
      .from(traceEvents)
      .where(eq(traceEvents.traceId, traceId))
      .orderBy(traceEvents.turnIndex)
      .limit(effectiveEventsLimit + 1);

    if (eventRows.length > effectiveEventsLimit) {
      events = eventRows.slice(0, effectiveEventsLimit);
      eventsTruncated = true;
    } else {
      events = eventRows;
      eventsTruncated = false;
    }
  }

  // 5. Handoff payloads
  let handoffRows: unknown[] | null = null;
  if (includeHandoffs) {
    handoffRows = await db
      .select()
      .from(handoffPayloads)
      .where(
        or(
          eq(handoffPayloads.producerTraceId, traceId),
          eq(handoffPayloads.consumerTraceId, traceId),
        ),
      );
  }

  return {
    trace,
    digest,
    raw,
    events,
    eventsTruncated,
    handoffPayloads: handoffRows,
    warnings,
  };
}
