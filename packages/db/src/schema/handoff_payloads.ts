import { pgTable, pgEnum, uuid, timestamp, jsonb, text, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { traces } from "./traces.js";

export const payloadTypeEnum = pgEnum("payload_type_enum", [
  "spec",
  "diff",
  "verdict",
  "evidence_bundle",
]);

export const handoffPayloads = pgTable(
  "handoff_payloads",
  {
    payloadId: uuid("payload_id").primaryKey().defaultRandom(),
    producerTraceId: uuid("producer_trace_id")
      .notNull()
      .references(() => traces.traceId, { onDelete: "cascade" }),
    consumerTraceId: uuid("consumer_trace_id").references(() => traces.traceId, {
      onDelete: "set null",
    }),
    payloadType: payloadTypeEnum("payload_type").notNull(),
    payloadContent: jsonb("payload_content"),
    payloadR2Key: text("payload_r2_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    producerIdx: index("handoff_payloads_producer_idx").on(table.producerTraceId),
    consumerIdx: index("handoff_payloads_consumer_idx").on(table.consumerTraceId),
    typeIdx: index("handoff_payloads_type_idx").on(table.payloadType),
    contentXorR2: check(
      "handoff_payloads_content_xor_r2",
      sql`(payload_content IS NOT NULL AND payload_r2_key IS NULL) OR (payload_content IS NULL AND payload_r2_key IS NOT NULL)`,
    ),
  }),
);
