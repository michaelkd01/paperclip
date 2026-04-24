import { S3Client } from "@aws-sdk/client-s3";
import { createDb } from "./db.js";
import { cleanup } from "./cleanup.js";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

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

export async function run(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  log("trace_cleanup_start", { dryRun });

  const r2 = buildR2Client();
  if (!r2) {
    log("r2_credentials_missing");
    process.exit(1);
  }

  const databaseUrl = getDatabaseUrl();
  const db = createDb(databaseUrl);

  try {
    const result = await cleanup({
      db,
      r2Client: r2.client,
      r2Bucket: r2.bucket,
      dryRun,
    });

    log("trace_cleanup_done", { ...result });

    if (result.errors.length > 0) {
      log("trace_cleanup_had_errors", { count: result.errors.length });
    }
  } finally {
    await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
  }
}
