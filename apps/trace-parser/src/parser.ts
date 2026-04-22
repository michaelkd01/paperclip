export interface ParseInput {
  jsonl: string;
  traceId: string;
}

export interface ParsedEvent {
  turnIndex: number;
  eventType: "assistant_text" | "tool_use" | "tool_result" | "decision_point";
  contentSummary: string;
  tokensIn: number | null;
  tokensOut: number | null;
  toolName: string | null;
  toolDurationMs: number | null;
  timestamp: Date;
}

export interface ParsedHandoff {
  payloadType: "spec" | "diff" | "verdict" | "evidence_bundle";
  payloadContent: unknown;
}

export interface ParseResult {
  events: ParsedEvent[];
  handoffs: ParsedHandoff[];
  warnings: string[];
  summary: {
    totalTurns: number;
    totalTokensIn: number;
    totalTokensOut: number;
    toolCallCounts: Record<string, number>;
  };
}

interface ToolUseRecord {
  toolName: string;
  timestamp: Date;
}

function safeSlice(value: unknown, maxLen: number): string {
  if (typeof value === "string") return value.slice(0, maxLen);
  try {
    return JSON.stringify(value).slice(0, maxLen);
  } catch {
    return String(value).slice(0, maxLen);
  }
}

export function parseTrace(input: ParseInput): ParseResult {
  const events: ParsedEvent[] = [];
  const handoffs: ParsedHandoff[] = [];
  const warnings: string[] = [];
  const toolCallCounts: Record<string, number> = {};

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let turnIndex = 0;

  // Map tool_use id -> { toolName, timestamp } for lookups by tool_result
  const toolUseMap = new Map<string, ToolUseRecord>();

  const lines = input.jsonl.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim();
    if (line.length === 0) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      warnings.push(`malformed_jsonl_line_${lineIdx + 1}`);
      continue;
    }

    const eventType = obj.type as string | undefined;

    // Skip system events
    if (eventType === "queue-operation" || eventType === "last-prompt") {
      continue;
    }

    if (eventType === "assistant") {
      turnIndex++;
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;

      const usage = message.usage as Record<string, unknown> | undefined;
      const tokensIn = typeof usage?.input_tokens === "number" ? usage.input_tokens as number : null;
      const tokensOut = typeof usage?.output_tokens === "number" ? usage.output_tokens as number : null;
      const cacheCreation = typeof usage?.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens as number : 0;
      const cacheRead = typeof usage?.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens as number : 0;

      if (tokensIn !== null) totalTokensIn += tokensIn + cacheCreation + cacheRead;
      if (tokensOut !== null) totalTokensOut += tokensOut;

      const iterations = usage?.iterations;
      if (Array.isArray(iterations) && iterations.length > 1) {
        warnings.push(`multi_iteration_turn_at_${turnIndex}_iterations=${iterations.length}`);
      }

      const timestamp = new Date(obj.timestamp as string);
      let emittedText = false;

      // Collect tool_use names in this turn for decision-point detection
      const turnToolNames: string[] = [];

      for (const block of content) {
        if (block.type === "text") {
          if (!emittedText) {
            events.push({
              turnIndex,
              eventType: "assistant_text",
              contentSummary: safeSlice(block.text, 500),
              tokensIn,
              tokensOut,
              toolName: null,
              toolDurationMs: null,
              timestamp,
            });
            emittedText = true;
          }
        } else if (block.type === "tool_use") {
          const toolName = block.name as string;
          const toolId = block.id as string;
          turnToolNames.push(toolName);
          toolCallCounts[toolName] = (toolCallCounts[toolName] ?? 0) + 1;

          toolUseMap.set(toolId, { toolName, timestamp });

          events.push({
            turnIndex,
            eventType: "tool_use",
            contentSummary: safeSlice(block.input, 500),
            tokensIn: null,
            tokensOut: null,
            toolName,
            toolDurationMs: null,
            timestamp,
          });

          detectHandoff(toolName, block.input as Record<string, unknown>, handoffs, warnings);
        }
        // Skip "thinking" blocks — not extractable events
      }

      // Decision-point heuristic: assistant_text followed by ≥2 distinct tool_use names
      const distinctToolNames = new Set(turnToolNames);
      if (emittedText && distinctToolNames.size >= 2) {
        const textEvent = events.find(
          (e) => e.turnIndex === turnIndex && e.eventType === "assistant_text",
        );
        if (textEvent) {
          events.push({
            turnIndex,
            eventType: "decision_point",
            contentSummary: `Decision: ${[...distinctToolNames].join(", ")} (${textEvent.contentSummary.slice(0, 200)})`,
            tokensIn: null,
            tokensOut: null,
            toolName: null,
            toolDurationMs: null,
            timestamp,
          });
        }
      }
    } else if (eventType === "user") {
      const message = obj.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const content = message.content;
      const timestamp = new Date(obj.timestamp as string);
      const toolUseResult = obj.toolUseResult as Record<string, unknown> | undefined;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;

          if (b.type === "tool_result") {
            const toolUseId = b.tool_use_id as string;
            const record = toolUseMap.get(toolUseId);
            const toolName = record?.toolName ?? null;
            const toolDurationMs = record ? timestamp.getTime() - record.timestamp.getTime() : null;

            let summary = safeSlice(b.content, 500);
            if (toolUseResult) {
              const resultPreview = buildToolUseResultPreview(toolUseResult);
              if (resultPreview) {
                summary = `${resultPreview} | ${summary}`.slice(0, 500);
              }
            }

            events.push({
              turnIndex,
              eventType: "tool_result",
              contentSummary: summary,
              tokensIn: null,
              tokensOut: null,
              toolName,
              toolDurationMs,
              timestamp,
            });
          }
        }
      }
      // First user event (string content, the prompt) — skip, not an extractable event
    } else if (eventType === "attachment") {
      const attachment = obj.attachment as Record<string, unknown> | undefined;
      if (!attachment) continue;

      // Only extract hook_success attachments as tool_result events
      if (attachment.type !== "hook_success") continue;

      const hookName = attachment.hookName as string | undefined;
      const toolUseID = attachment.toolUseID as string | undefined;
      const exitCode = attachment.exitCode;
      const stdout = attachment.stdout;
      const timestamp = new Date(obj.timestamp as string);

      const record = toolUseID ? toolUseMap.get(toolUseID) : undefined;
      const toolDurationMs = record ? timestamp.getTime() - record.timestamp.getTime() : null;

      events.push({
        turnIndex,
        eventType: "tool_result",
        contentSummary: `hook:${hookName ?? "unknown"} exit=${exitCode} stdout=${safeSlice(stdout, 200)}`,
        tokensIn: null,
        tokensOut: null,
        toolName: hookName ? `hook:${hookName}` : "hook:unknown",
        toolDurationMs,
        timestamp,
      });
    } else {
      // Unknown event type
      if (eventType) {
        warnings.push(`unknown_event_type_${eventType}_at_line_${lineIdx + 1}`);
      }
    }
  }

  return {
    events,
    handoffs,
    warnings,
    summary: {
      totalTurns: turnIndex,
      totalTokensIn,
      totalTokensOut,
      toolCallCounts,
    },
  };
}

function buildToolUseResultPreview(result: Record<string, unknown>): string | null {
  const parts: string[] = [];

  // Bash-style result
  if ("stdout" in result || "stderr" in result) {
    if (result.exitCode !== undefined) parts.push(`exit=${result.exitCode}`);
    if (typeof result.stdout === "string" && result.stdout.length > 0) {
      parts.push(`stdout=${result.stdout.slice(0, 200)}`);
    }
    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      parts.push(`stderr=${result.stderr.slice(0, 100)}`);
    }
    if (result.interrupted) parts.push("interrupted");
  }

  // Skill-style result
  if ("commandName" in result) {
    parts.push(`skill=${result.commandName}`);
    if (result.success !== undefined) parts.push(`success=${result.success}`);
  }

  // Read-style result
  if ("file" in result && "type" in result && !("stdout" in result)) {
    parts.push(`file=${result.file}`);
  }

  // Glob-style result
  if ("filenames" in result) {
    parts.push(`files=${result.numFiles}`);
    if (result.truncated) parts.push("truncated");
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function detectHandoff(
  toolName: string,
  input: Record<string, unknown> | undefined,
  handoffs: ParsedHandoff[],
  warnings: string[],
): void {
  if (!input) return;

  if (toolName === "mcp__claude_ai_Paperclip_Cloudflare_MCP__put_issue_document") {
    const key = input.key as string | undefined;
    if (key === "spec") {
      handoffs.push({
        payloadType: "spec",
        payloadContent: { body: input.body, title: input.title, format: input.format },
      });
    } else if (key === "outcome") {
      handoffs.push({ payloadType: "verdict", payloadContent: input });
    } else if (key === "ux-evidence") {
      handoffs.push({ payloadType: "evidence_bundle", payloadContent: input });
    }
  }

  if (toolName === "mcp__claude_ai_Paperclip_Cloudflare_MCP__update_issue") {
    const description = input.description as string | undefined;
    if (description) {
      if (description.length < 50) {
        warnings.push("short_description_handoff_suspect");
      }
      handoffs.push({
        payloadType: "spec",
        payloadContent: {
          description,
          acceptanceCriteria: input.acceptanceCriteria ?? input.acceptance_criteria,
        },
      });
    }
  }

  if (toolName === "mcp__claude_ai_Paperclip_Cloudflare_MCP__comment_on_issue") {
    const body = input.body as string | undefined;
    if (!body) return;

    const prUrlMatch = body.match(/https:\/\/github\.com\/.+\/pull\/\d+/);
    const shaMatch = body.match(/\b[0-9a-f]{7,40}\b/);

    if (prUrlMatch || shaMatch) {
      handoffs.push({
        payloadType: "diff",
        payloadContent: {
          body,
          detectedPrUrl: prUrlMatch?.[0] ?? null,
          detectedSha: shaMatch?.[0] ?? null,
        },
      });
    }
  }
}
