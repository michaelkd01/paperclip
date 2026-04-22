import { eq, and, isNull } from "drizzle-orm";
import { createDb, type Db } from "@paperclipai/db";
import { traces, traceEvents, handoffPayloads } from "@paperclipai/db";
import type { ParseResult } from "./parser.js";

export { createDb, type Db };

export async function persistParseResult(
  db: Db,
  traceId: string,
  result: ParseResult,
  parserVersion: string,
): Promise<void> {
  // Drizzle's postgres-js driver doesn't expose a raw transaction API with
  // manual begin/commit. Use drizzle's transaction helper instead.
  await db.transaction(async (tx) => {
    // Delete existing events for idempotency
    await tx.delete(traceEvents).where(eq(traceEvents.traceId, traceId));

    // Delete producer-side handoffs that haven't been linked to a consumer
    await tx
      .delete(handoffPayloads)
      .where(
        and(
          eq(handoffPayloads.producerTraceId, traceId),
          isNull(handoffPayloads.consumerTraceId),
        ),
      );

    // Insert events
    if (result.events.length > 0) {
      await tx.insert(traceEvents).values(
        result.events.map((e) => ({
          traceId,
          turnIndex: e.turnIndex,
          eventType: e.eventType,
          contentSummary: e.contentSummary,
          tokensIn: e.tokensIn,
          tokensOut: e.tokensOut,
          toolName: e.toolName,
          toolDurationMs: e.toolDurationMs,
          timestamp: e.timestamp,
        })),
      );
    }

    // Insert handoffs
    if (result.handoffs.length > 0) {
      await tx.insert(handoffPayloads).values(
        result.handoffs.map((h) => ({
          producerTraceId: traceId,
          payloadType: h.payloadType,
          payloadContent: h.payloadContent,
        })),
      );
    }

    // Update trace row
    await tx
      .update(traces)
      .set({
        parseStatus: "parsed",
        parsedAt: new Date(),
        parserVersion,
        parseWarnings: result.warnings.length > 0 ? result.warnings : null,
        tokensInTotal: result.summary.totalTokensIn || undefined,
        tokensOutTotal: result.summary.totalTokensOut || undefined,
      })
      .where(eq(traces.traceId, traceId));
  });
}

export async function markTraceParseFailed(
  db: Db,
  traceId: string,
  error: string,
): Promise<void> {
  await db
    .update(traces)
    .set({
      parseStatus: "failed",
      parsedAt: new Date(),
      parseWarnings: [error],
    })
    .where(eq(traces.traceId, traceId));
}

export async function fetchPendingTraces(
  db: Db,
  limit: number = 20,
): Promise<Array<{ traceId: string; r2RawKey: string | null }>> {
  const rows = await db
    .select({
      traceId: traces.traceId,
      r2RawKey: traces.r2RawKey,
    })
    .from(traces)
    .where(eq(traces.parseStatus, "pending"))
    .limit(limit);

  return rows;
}

export interface TraceMetadata {
  traceId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  stage: string | null;
  model: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  outcomeMarker: string | null;
}

export async function fetchTraceMetadata(
  db: Db,
  traceId: string,
): Promise<TraceMetadata | null> {
  const rows = await db
    .select({
      traceId: traces.traceId,
      companyId: traces.companyId,
      issueId: traces.issueId,
      agentId: traces.agentId,
      stage: traces.stage,
      model: traces.model,
      startedAt: traces.startedAt,
      endedAt: traces.endedAt,
      durationMs: traces.durationMs,
      outcomeMarker: traces.outcomeMarker,
    })
    .from(traces)
    .where(eq(traces.traceId, traceId))
    .limit(1);

  return rows[0] ?? null;
}
