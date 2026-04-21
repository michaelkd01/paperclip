CREATE TYPE "public"."payload_type_enum" AS ENUM('spec', 'diff', 'verdict', 'evidence_bundle');--> statement-breakpoint
CREATE TYPE "public"."event_type_enum" AS ENUM('assistant_text', 'tool_use', 'tool_result', 'decision_point');--> statement-breakpoint
CREATE TYPE "public"."parse_status_enum" AS ENUM('pending', 'parsed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."stage_enum" AS ENUM('pre-planner', 'executor', 'test', 'ux-verifier', 'supervisor', 'conductor', 'ceo');--> statement-breakpoint
CREATE TABLE "handoff_payloads" (
	"payload_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"producer_trace_id" uuid NOT NULL,
	"consumer_trace_id" uuid,
	"payload_type" "payload_type_enum" NOT NULL,
	"payload_content" jsonb,
	"payload_r2_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoff_payloads_content_xor_r2" CHECK ((payload_content IS NOT NULL AND payload_r2_key IS NULL) OR (payload_content IS NULL AND payload_r2_key IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "trace_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"event_type" "event_type_enum" NOT NULL,
	"content_summary" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"tool_name" text,
	"tool_duration_ms" integer,
	"timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"trace_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"stage" "stage_enum",
	"model" text,
	"session_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"tokens_in_total" integer,
	"tokens_out_total" integer,
	"outcome_marker" text,
	"r2_raw_key" text,
	"r2_digest_key" text,
	"benchmark_candidate" boolean DEFAULT false NOT NULL,
	"parse_status" "parse_status_enum" DEFAULT 'pending' NOT NULL,
	"parse_warnings" jsonb,
	"parsed_at" timestamp with time zone,
	"parser_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traces_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "trace_id" uuid;--> statement-breakpoint
ALTER TABLE "handoff_payloads" ADD CONSTRAINT "handoff_payloads_producer_trace_id_traces_trace_id_fk" FOREIGN KEY ("producer_trace_id") REFERENCES "public"."traces"("trace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_payloads" ADD CONSTRAINT "handoff_payloads_consumer_trace_id_traces_trace_id_fk" FOREIGN KEY ("consumer_trace_id") REFERENCES "public"."traces"("trace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_trace_id_traces_trace_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("trace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoff_payloads_producer_idx" ON "handoff_payloads" USING btree ("producer_trace_id");--> statement-breakpoint
CREATE INDEX "handoff_payloads_consumer_idx" ON "handoff_payloads" USING btree ("consumer_trace_id");--> statement-breakpoint
CREATE INDEX "handoff_payloads_type_idx" ON "handoff_payloads" USING btree ("payload_type");--> statement-breakpoint
CREATE INDEX "trace_events_trace_id_turn_index_idx" ON "trace_events" USING btree ("trace_id","turn_index");--> statement-breakpoint
CREATE INDEX "trace_events_tool_name_idx" ON "trace_events" USING btree ("tool_name") WHERE "trace_events"."tool_name" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trace_events_event_type_idx" ON "trace_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "traces_company_id_created_at_idx" ON "traces" USING btree ("company_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "traces_issue_id_created_at_idx" ON "traces" USING btree ("issue_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "traces_agent_id_created_at_idx" ON "traces" USING btree ("agent_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "traces_stage_created_at_idx" ON "traces" USING btree ("stage","created_at" DESC);--> statement-breakpoint
CREATE INDEX "traces_benchmark_candidate_idx" ON "traces" USING btree ("benchmark_candidate") WHERE "traces"."benchmark_candidate" = true;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_trace_id_traces_trace_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("trace_id") ON DELETE set null ON UPDATE no action;