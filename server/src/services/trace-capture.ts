import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Db } from "@paperclipai/db";
import { traces, heartbeatRuns } from "@paperclipai/db";

/**
 * Maps agent role strings to the stage_enum values defined in ADR-004-2.
 * Returns null for unrecognised roles — never guesses.
 */
export function mapRoleToStage(
  role: string | null,
): "pre-planner" | "executor" | "test" | "ux-verifier" | "supervisor" | "conductor" | "ceo" | null {
  if (!role) return null;
  const known = new Set([
    "pre-planner",
    "executor",
    "test",
    "ux-verifier",
    "supervisor",
    "conductor",
    "ceo",
  ]);
  // Some older records use "pm" for conductor — return null rather than guess.
  return known.has(role) ? (role as ReturnType<typeof mapRoleToStage>) : null;
}

export interface CaptureTraceArgs {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string | null;
  agentId: string;
  agentRole: string | null;
  model: string | null;
  sessionId: string | null;
  startedAt: Date;
  endedAt: Date;
  tokensInTotal: number | null;
  tokensOutTotal: number | null;
  outcomeMarker: string | null;
  /** The cwd the adapter ran in — used to locate the session transcript under ~/.claude/projects/ */
  adapterCwd: string | null;
}

export interface CaptureTraceResult {
  traceId: string | null;
  r2RawKey: string | null;
  warnings: string[];
}

/**
 * Derives the Claude Code project slug from a working directory path.
 * Claude uses the convention: replace all path separators with '-', prepend '-'.
 * e.g. /Users/foo/bar → -Users-foo-bar
 */
function cwdToProjectSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

/**
 * Resolve the session transcript JSONL file for a given session.
 *
 * Strategy: sessionId-first, mtime fallback.
 *  1. If sessionId and adapterCwd are known, try the direct path.
 *  2. If sessionId is known but cwd is not (or direct path missing), scan all project dirs.
 *  3. If sessionId is unknown, scan by mtime (within 5s of endedAt).
 *
 * Returns { path, strategy } or null.
 */
async function resolveSessionTranscript(args: {
  sessionId: string | null;
  adapterCwd: string | null;
  endedAt: Date;
}): Promise<{ path: string; strategy: "session_id_direct" | "session_id_scan" | "mtime_scan" } | null> {
  const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects");

  // Strategy 1: direct path from sessionId + cwd
  if (args.sessionId && args.adapterCwd) {
    const slug = cwdToProjectSlug(args.adapterCwd);
    const directPath = path.join(claudeProjectsDir, slug, `${args.sessionId}.jsonl`);
    try {
      const stat = await fs.stat(directPath);
      if (stat.size > 0) {
        return { path: directPath, strategy: "session_id_direct" };
      }
    } catch {
      // File doesn't exist at direct path — fall through
    }
  }

  // Strategy 2: scan all project dirs for sessionId
  if (args.sessionId) {
    try {
      const dirs = await fs.readdir(claudeProjectsDir);
      for (const dir of dirs) {
        const candidate = path.join(claudeProjectsDir, dir, `${args.sessionId}.jsonl`);
        try {
          const stat = await fs.stat(candidate);
          if (stat.size > 0) {
            return { path: candidate, strategy: "session_id_scan" };
          }
        } catch {
          // Not in this dir
        }
      }
    } catch {
      // Can't read projects dir
    }
  }

  // Strategy 3: mtime scan — find any JSONL whose mtime is within 5s of endedAt
  try {
    const dirs = await fs.readdir(claudeProjectsDir);
    const endMs = args.endedAt.getTime();
    let bestCandidate: { path: string; diff: number } | null = null;

    for (const dir of dirs) {
      const dirPath = path.join(claudeProjectsDir, dir);
      let entries: string[];
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const filePath = path.join(dirPath, entry);
        try {
          const stat = await fs.stat(filePath);
          if (stat.size === 0) continue;
          const diff = Math.abs(stat.mtimeMs - endMs);
          if (diff <= 5000 && (!bestCandidate || diff < bestCandidate.diff)) {
            bestCandidate = { path: filePath, diff };
          }
        } catch {
          // skip
        }
      }
    }

    if (bestCandidate) {
      return { path: bestCandidate.path, strategy: "mtime_scan" };
    }
  } catch {
    // Can't read projects dir at all
  }

  return null;
}

/**
 * Validate JSONL: check that every line parses as JSON.
 * Returns warnings for malformed lines but does not abort.
 */
function validateJsonl(content: string): string[] {
  const warnings: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
    } catch {
      warnings.push(`malformed_jsonl_line_${i + 1}`);
    }
  }
  return warnings;
}

/**
 * Build a lazily-initialised S3Client for R2.
 * Returns null if env vars are missing (fail-soft).
 */
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

/**
 * Fail-soft post-run hook: captures the Claude Code session JSONL,
 * uploads it to R2, and writes a row into the `traces` table.
 *
 * No exception must propagate out of this function.
 * This is the fail-soft requirement — capture never fails a run.
 */
export async function captureTrace(args: CaptureTraceArgs): Promise<CaptureTraceResult> {
  const warnings: string[] = [];

  try {
    // Guard: skip when issueId is null
    if (!args.issueId) {
      const result = { traceId: null, r2RawKey: null, warnings: ["no_issue_id_run_skipped"] };
      console.log(
        JSON.stringify({
          event: "trace_capture_skipped",
          reason: "no_issue_id",
          run_id: args.runId,
        }),
      );
      return result;
    }

    // 1. Resolve the session transcript
    const transcript = await resolveSessionTranscript({
      sessionId: args.sessionId,
      adapterCwd: args.adapterCwd,
      endedAt: args.endedAt,
    });

    if (!transcript) {
      console.log(
        JSON.stringify({
          event: "trace_capture_skipped",
          reason: "session_transcript_not_found",
          run_id: args.runId,
          session_id: args.sessionId,
        }),
      );
      return { traceId: null, r2RawKey: null, warnings: ["session_transcript_not_found"] };
    }

    console.log(
      JSON.stringify({
        event: "trace_transcript_resolved",
        run_id: args.runId,
        strategy: transcript.strategy,
        path: transcript.path,
      }),
    );

    // 2. Read and validate JSONL
    const content = await fs.readFile(transcript.path, "utf-8");
    const jsonlWarnings = validateJsonl(content);
    warnings.push(...jsonlWarnings);

    // 3. Build R2 key
    const stage = mapRoleToStage(args.agentRole);
    const r2RawKey = `traces/${args.companyId}/${args.issueId}/${stage ?? "unknown"}/${args.runId}.jsonl`;

    // 4. Upload to R2
    const r2 = buildR2Client();
    if (!r2) {
      warnings.push("r2_credentials_missing");
      console.warn(
        JSON.stringify({
          event: "trace_capture_r2_missing",
          run_id: args.runId,
          reason: "One or more PAPERCLIP_TRACES_R2_* env vars are not set",
        }),
      );
      return { traceId: null, r2RawKey: null, warnings };
    }

    const contentBuffer = Buffer.from(content, "utf-8");
    await r2.client.send(
      new PutObjectCommand({
        Bucket: r2.bucket,
        Key: r2RawKey,
        Body: contentBuffer,
        ContentType: "application/x-ndjson",
      }),
    );

    // 5. INSERT into traces
    const durationMs = args.endedAt.getTime() - args.startedAt.getTime();
    const [traceRow] = await args.db
      .insert(traces)
      .values({
        runId: args.runId,
        companyId: args.companyId,
        issueId: args.issueId,
        agentId: args.agentId,
        stage,
        model: args.model,
        sessionId: args.sessionId,
        startedAt: args.startedAt,
        endedAt: args.endedAt,
        durationMs,
        tokensInTotal: args.tokensInTotal,
        tokensOutTotal: args.tokensOutTotal,
        outcomeMarker: args.outcomeMarker,
        r2RawKey,
        parseStatus: "pending",
        parseWarnings: warnings.length > 0 ? warnings : null,
      })
      .returning({ traceId: traces.traceId });

    const traceId = traceRow.traceId;

    // 6. UPDATE heartbeat_runs SET trace_id
    await args.db
      .update(heartbeatRuns)
      .set({ traceId })
      .where(eq(heartbeatRuns.id, args.runId));

    // 7. Emit structured log
    console.log(
      JSON.stringify({
        event: "trace_captured",
        trace_id: traceId,
        run_id: args.runId,
        r2_raw_key: r2RawKey,
        bytes: contentBuffer.byteLength,
        duration_ms: durationMs,
        strategy: transcript.strategy,
        warnings,
      }),
    );

    return { traceId, r2RawKey, warnings };
  } catch (err) {
    // 8. Top-level catch: no exception propagates
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(message);
    console.warn(
      JSON.stringify({
        event: "trace_capture_failure",
        run_id: args.runId,
        error: message,
        warnings,
      }),
    );
    return { traceId: null, r2RawKey: null, warnings };
  }
}
