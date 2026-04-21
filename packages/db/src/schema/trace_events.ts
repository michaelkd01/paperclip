import { pgTable, pgEnum, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { traces } from "./traces.js";

export const eventTypeEnum = pgEnum("event_type_enum", [
  "assistant_text",
  "tool_use",
  "tool_result",
  "decision_point",
]);

export const traceEvents = pgTable(
  "trace_events",
  {
    eventId: uuid("event_id").primaryKey().defaultRandom(),
    traceId: uuid("trace_id")
      .notNull()
      .references(() => traces.traceId, { onDelete: "cascade" }),
    turnIndex: integer("turn_index").notNull(),
    eventType: eventTypeEnum("event_type").notNull(),
    contentSummary: text("content_summary"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    toolName: text("tool_name"),
    toolDurationMs: integer("tool_duration_ms"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (table) => ({
    traceIdTurnIdx: index("trace_events_trace_id_turn_index_idx").on(
      table.traceId,
      table.turnIndex,
    ),
    toolNameIdx: index("trace_events_tool_name_idx")
      .on(table.toolName)
      .where(sql`${table.toolName} IS NOT NULL`),
    eventTypeIdx: index("trace_events_event_type_idx").on(table.eventType),
  }),
);
