ALTER TABLE "traces" ADD COLUMN "tokens_in_per_run" integer;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "tokens_out_per_run" integer;--> statement-breakpoint

-- Backfill per-run token columns from heartbeat_runs.usage_json for existing rows
UPDATE traces t
SET
  tokens_in_per_run = COALESCE((hr.usage_json->>'inputTokens')::int, 0)
                    + COALESCE((hr.usage_json->>'cachedInputTokens')::int, 0),
  tokens_out_per_run = COALESCE((hr.usage_json->>'outputTokens')::int, 0)
FROM heartbeat_runs hr
WHERE hr.trace_id = t.trace_id
  AND hr.usage_json IS NOT NULL
  AND t.tokens_in_per_run IS NULL;