import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const stageEnum = pgEnum("stage_enum", [
  "pre-planner",
  "executor",
  "test",
  "ux-verifier",
  "supervisor",
  "conductor",
  "ceo",
]);

export const parseStatusEnum = pgEnum("parse_status_enum", [
  "pending",
  "parsed",
  "failed",
  "expired",
]);

export const traces = pgTable(
  "traces",
  {
    traceId: uuid("trace_id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .unique()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    stage: stageEnum("stage"),
    model: text("model"),
    sessionId: text("session_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    tokensInTotal: integer("tokens_in_total"),
    tokensOutTotal: integer("tokens_out_total"),
    outcomeMarker: text("outcome_marker"),
    r2RawKey: text("r2_raw_key"),
    r2DigestKey: text("r2_digest_key"),
    benchmarkCandidate: boolean("benchmark_candidate").notNull().default(false),
    parseStatus: parseStatusEnum("parse_status").notNull().default("pending"),
    parseWarnings: jsonb("parse_warnings"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }),
    parserVersion: text("parser_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("traces_company_id_created_at_idx").on(
      table.companyId,
      sql`${table.createdAt} DESC`,
    ),
    issueCreatedIdx: index("traces_issue_id_created_at_idx").on(
      table.issueId,
      sql`${table.createdAt} DESC`,
    ),
    agentCreatedIdx: index("traces_agent_id_created_at_idx").on(
      table.agentId,
      sql`${table.createdAt} DESC`,
    ),
    stageCreatedIdx: index("traces_stage_created_at_idx").on(
      table.stage,
      sql`${table.createdAt} DESC`,
    ),
    benchmarkCandidateIdx: index("traces_benchmark_candidate_idx")
      .on(table.benchmarkCandidate)
      .where(sql`${table.benchmarkCandidate} = true`),
  }),
);
