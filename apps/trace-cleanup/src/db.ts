import { eq, and, lt, or } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { traces, traceEvents, handoffPayloads } from "@paperclipai/db";

export { createDb, type Db };

export interface ExpiredTrace {
  traceId: string;
  r2RawKey: string | null;
  r2DigestKey: string | null;
}

export interface HandoffPayloadRow {
  payloadId: string;
  producerTraceId: string;
  consumerTraceId: string | null;
  payloadR2Key: string | null;
}

const RETENTION_DAYS = 90;

export async function fetchExpiredTraces(db: Db): Promise<ExpiredTrace[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);

  const rows = await db
    .select({
      traceId: traces.traceId,
      r2RawKey: traces.r2RawKey,
      r2DigestKey: traces.r2DigestKey,
    })
    .from(traces)
    .where(
      and(
        lt(traces.createdAt, cutoff),
        eq(traces.benchmarkCandidate, false),
      ),
    );

  return rows;
}

export async function deleteTraceEventsForTrace(db: Db, traceId: string): Promise<number> {
  const result = await db
    .delete(traceEvents)
    .where(eq(traceEvents.traceId, traceId))
    .returning({ eventId: traceEvents.eventId });

  return result.length;
}

export async function fetchHandoffPayloadsForTrace(db: Db, traceId: string): Promise<HandoffPayloadRow[]> {
  const rows = await db
    .select({
      payloadId: handoffPayloads.payloadId,
      producerTraceId: handoffPayloads.producerTraceId,
      consumerTraceId: handoffPayloads.consumerTraceId,
      payloadR2Key: handoffPayloads.payloadR2Key,
    })
    .from(handoffPayloads)
    .where(
      or(
        eq(handoffPayloads.producerTraceId, traceId),
        eq(handoffPayloads.consumerTraceId, traceId),
      ),
    );

  return rows;
}

export async function deleteHandoffPayload(db: Db, payloadId: string): Promise<void> {
  await db
    .delete(handoffPayloads)
    .where(eq(handoffPayloads.payloadId, payloadId));
}

export async function nullifyTraceR2Keys(db: Db, traceId: string): Promise<void> {
  await db
    .update(traces)
    .set({ r2RawKey: null, r2DigestKey: null })
    .where(eq(traces.traceId, traceId));
}
