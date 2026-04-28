/**
 * Session JSONL Parser
 *
 * 逐行读取 session JSONL，提取每行的类型和关键字段。
 * 不做复杂索引，只为 builder 提供结构化的行数据。
 */

import { readFile } from "node:fs/promises";
import { estimateTokens } from "../utils/tokens.js";
import type { EntryType, MessageRole } from "./types.js";

/** 一行解析后的结构化数据 */
export interface ParsedLine {
  /** 行号（1-based） */
  line: number;
  /** entry 类型 */
  type: EntryType;
  /** entry id */
  entryId: string;
  /** 时间戳 */
  timestamp: string;

  // ── 仅 message 类型有以下字段 ──
  /** 消息角色 */
  role?: MessageRole;
  /** 估算 token 数 */
  tokenEstimate?: number;
  /** user 消息的文本预览 */
  userText?: string;
  /** assistant 消息的文本预览 */
  assistantText?: string;
  /** assistant 消息中调用的工具名列表 */
  toolCalls?: string[];
  /** toolResult 的工具名 */
  toolName?: string;
  /** toolResult 是否出错 */
  isError?: boolean;

  // ── 仅 session 类型有以下字段 ──
  sessionId?: string;
  sessionVersion?: number;
  cwd?: string;

  // ── 仅 model_change 类型有以下字段 ──
  provider?: string;
  modelId?: string;
}

/**
 * 解析 session JSONL 文件的全部行。
 * 支持 startLine 参数用于增量解析（1-based）。
 */
export async function parseSessionFile(
  filePath: string,
  startLine: number = 1,
): Promise<ParsedLine[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const results: ParsedLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1; // 1-based
    if (lineNum < startLine) continue;

    const raw = lines[i].trim();
    if (!raw) continue;

    try {
      const obj = JSON.parse(raw);
      const parsed = parseLine(obj, lineNum);
      if (parsed) results.push(parsed);
    } catch {
      // 跳过格式错误的行
    }
  }

  return results;
}

function parseLine(obj: Record<string, unknown>, line: number): ParsedLine | null {
  const type = mapEntryType(obj.type as string);
  const base: ParsedLine = {
    line,
    type,
    entryId: (obj.id as string) ?? `line-${line}`,
    timestamp: (obj.timestamp as string) ?? "",
  };

  switch (type) {
    case "session": {
      base.sessionId = obj.id as string;
      base.sessionVersion = obj.version as number;
      base.cwd = obj.cwd as string;
      return base;
    }
    case "model_change": {
      base.provider = obj.provider as string;
      base.modelId = obj.modelId as string;
      return base;
    }
    case "message": {
      const msg = obj.message as Record<string, unknown>;
      if (!msg) return base;
      return parseMessage(base, msg);
    }
    default:
      return base;
  }
}

function parseMessage(base: ParsedLine, msg: Record<string, unknown>): ParsedLine {
  const role = mapRole(msg.role as string);
  base.role = role;
  base.tokenEstimate = 0;

  if (role === "user") {
    const text = extractText(msg.content);
    const cleanText = stripSenderMetadata(text);
    base.userText = cleanText.slice(0, 200);
    base.tokenEstimate = estimateTokens(text);
  } else if (role === "assistant") {
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const toolCalls: string[] = [];
    let assistantText = "";
    let tokens = 0;

    for (const part of parts) {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        assistantText = p.text;
        tokens += estimateTokens(p.text);
      } else if (p.type === "toolCall") {
        if (typeof p.name === "string") toolCalls.push(p.name);
        const argsStr = JSON.stringify(p.arguments ?? p.input ?? {});
        tokens += estimateTokens(argsStr);
      }
    }

    // 优先用 provider 报告的 output tokens
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (usage?.output && typeof usage.output === "number") {
      tokens = usage.output;
    }

    base.assistantText = assistantText.slice(0, 200);
    base.toolCalls = toolCalls.length > 0 ? toolCalls : undefined;
    base.tokenEstimate = tokens;
  } else if (role === "toolResult") {
    const text = extractText(msg.content);
    base.tokenEstimate = estimateTokens(text);
    base.toolName = msg.toolName as string | undefined;
    base.isError = (msg.isError as boolean) ?? false;
  }

  return base;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Record<string, unknown>) =>
        typeof c.text === "string" ? c.text : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * Strip untrusted sender metadata block from user messages.
 *
 * OpenClaw injects metadata like:
 *   Sender (untrusted metadata):
 *   ```json
 *   { "label": "...", "id": "..." }
 *   ```
 *   [Tue 2026-04-28 10:06 GMT+8] actual message
 *
 * This function extracts only the actual user message.
 */
function stripSenderMetadata(text: string): string {
  // Pattern: Strip everything from "Sender (untrusted metadata):" through the closing ``` and any trailing newlines
  // Then strip the timestamp prefix [Tue 2026-04-28 10:06 GMT+8]
  const metaBlockPattern = /^Sender\s*\(untrusted metadata\):\n```json\n[\s\S]*?```\n*/;
  let cleaned = text.replace(metaBlockPattern, "");

  // Strip timestamp prefix like "[Tue 2026-04-28 10:06 GMT+8] "
  const timestampPattern = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/;
  cleaned = cleaned.replace(timestampPattern, "");

  return cleaned.trim() || text.trim();
}

function mapEntryType(t: string): EntryType {
  switch (t) {
    case "session": return "session";
    case "model_change": return "model_change";
    case "thinking_level_change": return "thinking_level_change";
    case "custom": return "custom";
    case "message": return "message";
    default: return "custom";
  }
}

function mapRole(r: string): MessageRole {
  switch (r) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "toolResult": return "toolResult";
    default: return "user";
  }
}
