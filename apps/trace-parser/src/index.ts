import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { parseTrace } from "./parser.js";
import {
  createDb,
  fetchPendingTraces,
  fetchTraceMetadata,
  persistParseResult,
  markTraceParseFailed,
} from "./db.js";
import { renderDigest } from "./digest.js";

const PARSER_VERSION = "1.0.0";

function buildR2Client(): { client: S3Client; bucket: string } | null {
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

function getDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

async function handleTrace(
  db: ReturnType<typeof createDb>,
  r2: { client: S3Client; bucket: string },
  traceId: string,
  r2RawKey: string,
): Promise<void> {
  if (!r2RawKey.endsWith(".jsonl")) {
    log("trace_skip_not_jsonl", { traceId, r2RawKey });
    return;
  }

  try {
    const obj = await r2.client.send(
      new GetObjectCommand({ Bucket: r2.bucket, Key: r2RawKey }),
    );
    const jsonl = await obj.Body?.transformToString("utf-8");
    if (!jsonl) {
      log("trace_skip_empty", { traceId, r2RawKey });
      await markTraceParseFailed(db, traceId, "r2_object_empty");
      return;
    }

    const result = parseTrace({ jsonl, traceId });

    await persistParseResult(db, traceId, result, PARSER_VERSION);

    const meta = await fetchTraceMetadata(db, traceId);
    if (meta) {
      const digest = renderDigest(meta, result, PARSER_VERSION);
      const digestKey = r2RawKey.replace(/\.jsonl$/, ".digest.md");
      await r2.client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: digestKey,
          Body: digest,
          ContentType: "text/markdown",
        }),
      );

      // Update r2_digest_key on the trace row
      const { traces } = await import("@paperclipai/db");
      const { eq } = await import("drizzle-orm");
      await db.update(traces).set({ r2DigestKey: digestKey }).where(eq(traces.traceId, traceId));
    }

    log("trace_parsed", {
      traceId,
      events: result.events.length,
      handoffs: result.handoffs.length,
      warnings: result.warnings.length,
      tokensIn: result.summary.totalTokensIn,
      tokensOut: result.summary.totalTokensOut,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("trace_parse_failed", { traceId, error: message });
    try {
      await markTraceParseFailed(db, traceId, message);
    } catch (dbErr) {
      log("trace_mark_failed_error", {
        traceId,
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  }
}

export async function parseOnce(): Promise<{ processed: number; errors: number }> {
  const databaseUrl = getDatabaseUrl();
  const db = createDb(databaseUrl);
  const r2 = buildR2Client();

  if (!r2) {
    log("r2_credentials_missing");
    return { processed: 0, errors: 0 };
  }

  let processed = 0;
  let errors = 0;

  try {
    const pending = await fetchPendingTraces(db, 20);
    if (pending.length === 0) {
      log("no_pending_traces");
      return { processed: 0, errors: 0 };
    }

    log("pending_traces_found", { count: pending.length });

    for (const trace of pending) {
      if (!trace.r2RawKey) {
        log("trace_skip_no_r2_key", { traceId: trace.traceId });
        await markTraceParseFailed(db, trace.traceId, "no_r2_raw_key");
        errors++;
        continue;
      }

      try {
        await handleTrace(db, r2, trace.traceId, trace.r2RawKey);
        processed++;
      } catch {
        errors++;
      }
    }
  } finally {
    // Close the postgres connection
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }

  log("parse_once_complete", { processed, errors });
  return { processed, errors };
}

// Run when invoked directly
parseOnce()
  .then((result) => {
    process.exit(result.errors > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(2);
  });
