import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Db } from "@paperclipai/db";
import {
  fetchExpiredTraces,
  deleteTraceEventsForTrace,
  fetchHandoffPayloadsForTrace,
  deleteHandoffPayload,
  nullifyTraceR2Keys,
} from "./db.js";

export interface CleanupResult {
  tracesCleaned: number;
  eventsDeleted: number;
  r2ObjectsDeleted: number;
  handoffPayloadsDeleted: number;
  errors: string[];
}

export interface CleanupOptions {
  db: Db;
  r2Client: S3Client;
  r2Bucket: string;
  dryRun: boolean;
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

async function deleteR2Object(
  r2Client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await r2Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    log("r2_delete_failed", {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
  const { db, r2Client, r2Bucket, dryRun } = options;

  const result: CleanupResult = {
    tracesCleaned: 0,
    eventsDeleted: 0,
    r2ObjectsDeleted: 0,
    handoffPayloadsDeleted: 0,
    errors: [],
  };

  const expired = await fetchExpiredTraces(db);

  if (expired.length === 0) {
    log("nothing_to_clean");
    return result;
  }

  log("expired_traces_found", { count: expired.length, dryRun });

  for (const trace of expired) {
    if (dryRun) {
      log("dry_run_candidate", {
        traceId: trace.traceId,
        r2RawKey: trace.r2RawKey,
        r2DigestKey: trace.r2DigestKey,
      });
      result.tracesCleaned++;
      continue;
    }

    try {
      // 1. Delete R2 objects
      if (trace.r2RawKey) {
        if (await deleteR2Object(r2Client, r2Bucket, trace.r2RawKey)) {
          result.r2ObjectsDeleted++;
        } else {
          result.errors.push(`r2_delete_failed:${trace.r2RawKey}`);
        }
      }
      if (trace.r2DigestKey) {
        if (await deleteR2Object(r2Client, r2Bucket, trace.r2DigestKey)) {
          result.r2ObjectsDeleted++;
        } else {
          result.errors.push(`r2_delete_failed:${trace.r2DigestKey}`);
        }
      }

      // 2. Delete trace_events
      const eventsCount = await deleteTraceEventsForTrace(db, trace.traceId);
      result.eventsDeleted += eventsCount;

      // 3. Handle handoff_payloads
      const handoffs = await fetchHandoffPayloadsForTrace(db, trace.traceId);
      for (const hp of handoffs) {
        if (hp.payloadR2Key) {
          if (await deleteR2Object(r2Client, r2Bucket, hp.payloadR2Key)) {
            result.r2ObjectsDeleted++;
          } else {
            result.errors.push(`r2_delete_failed:${hp.payloadR2Key}`);
          }
        }
        await deleteHandoffPayload(db, hp.payloadId);
        result.handoffPayloadsDeleted++;
      }

      // 4. Nullify R2 keys on the trace row (preserve the shell)
      await nullifyTraceR2Keys(db, trace.traceId);

      result.tracesCleaned++;
      log("trace_cleaned", { traceId: trace.traceId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`trace_error:${trace.traceId}:${message}`);
      log("trace_cleanup_error", { traceId: trace.traceId, error: message });
    }
  }

  log("cleanup_complete", {
    tracesCleaned: result.tracesCleaned,
    eventsDeleted: result.eventsDeleted,
    r2ObjectsDeleted: result.r2ObjectsDeleted,
    handoffPayloadsDeleted: result.handoffPayloadsDeleted,
    errors: result.errors.length,
    dryRun,
  });

  return result;
}
