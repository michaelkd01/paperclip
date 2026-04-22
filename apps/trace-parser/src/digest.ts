import type { ParseResult } from "./parser.js";
import type { TraceMetadata } from "./db.js";

export function renderDigest(
  meta: TraceMetadata,
  result: ParseResult,
  parserVersion: string,
): string {
  const lines: string[] = [];

  lines.push(`# Trace ${meta.traceId}`);
  lines.push("");
  lines.push(`- **Company:** ${meta.companyId}`);
  lines.push(`- **Issue:** ${meta.issueId}`);
  lines.push(`- **Agent:** ${meta.agentId} (${meta.stage ?? "unknown"})`);
  lines.push(`- **Model:** ${meta.model ?? "unknown"}`);
  lines.push(`- **Started:** ${meta.startedAt.toISOString()}`);
  if (meta.durationMs !== null) {
    lines.push(`- **Duration:** ${meta.durationMs}ms`);
  }
  lines.push(
    `- **Tokens:** ${result.summary.totalTokensIn} in / ${result.summary.totalTokensOut} out`,
  );
  if (meta.outcomeMarker) {
    lines.push(`- **Outcome:** ${meta.outcomeMarker}`);
  }

  lines.push("");
  lines.push("## Turn summary");
  lines.push("");
  lines.push("| # | Type | Tool | Tokens in | Tokens out | Duration | Summary |");
  lines.push("|---|------|------|-----------|-----------|----------|---------|");

  for (const event of result.events) {
    const summary = event.contentSummary
      .replace(/\|/g, "\\|")
      .replace(/\n/g, " ")
      .slice(0, 120);
    const duration = event.toolDurationMs !== null ? `${event.toolDurationMs}ms` : "";
    lines.push(
      `| ${event.turnIndex} | ${event.eventType} | ${event.toolName ?? ""} | ${event.tokensIn ?? ""} | ${event.tokensOut ?? ""} | ${duration} | ${summary} |`,
    );
  }

  lines.push("");
  lines.push("## Tool call counts");
  lines.push("");
  const sortedTools = Object.entries(result.summary.toolCallCounts).sort(
    ([, a], [, b]) => b - a,
  );
  for (const [tool, count] of sortedTools) {
    lines.push(`- ${tool}: ${count}`);
  }

  if (result.handoffs.length > 0) {
    lines.push("");
    lines.push("## Handoff payloads");
    lines.push("");
    for (const handoff of result.handoffs) {
      const preview = JSON.stringify(handoff.payloadContent).slice(0, 120);
      lines.push(`- ${handoff.payloadType}: ${preview}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`Parser version: ${parserVersion}`);
  lines.push("");

  return lines.join("\n");
}
