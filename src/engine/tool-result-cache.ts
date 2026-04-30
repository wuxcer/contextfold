/**
 * Tool Result Cache — tool result 截断结果持久化
 *
 * 对非保护区 turn 中的大 tool result 进行 head+tail 截断后，
 * 将截断结果缓存到磁盘，保证：
 *   1. 后续 assemble 直接用缓存版本，不重复计算
 *   2. KV cache 稳定——同一 turn 的内容不会在两次请求间变化
 *
 * 缓存文件与 session JSONL 同目录：<sessionId>.toolresults.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

/** 单个被截断的 tool result 缓存条目 */
export interface CachedToolResult {
  /** 截断后的文本 */
  truncatedContent: string;
  /** 截断后的 token 估算 */
  truncatedTokens: number;
  /** 原始 token 数 */
  originalTokens: number;
  /** 原始字符数 */
  originalChars: number;
  /** 截断时间 */
  truncatedAt: string;
}

/** 一个 turn 内可能有多个 tool result，用 messageIndex 区分 */
export interface TurnToolResultCache {
  /** turn 内 tool result 消息的 index → 缓存条目 */
  results: Record<number, CachedToolResult>;
}

/** 整个 session 的 tool result 缓存 */
export interface ToolResultCache {
  version: number;
  /** turnId → TurnToolResultCache */
  entries: Record<string, TurnToolResultCache>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 1;

/** head+tail 截断中间的省略标记 */
const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

/** 截断后缀 */
const TRUNCATION_SUFFIX =
  "\n[truncated: tool output exceeded budget, head+tail preserved]";

// ═══════════════════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════════════════

export function getToolResultCachePath(sessionFilePath: string): string {
  return sessionFilePath.replace(/\.jsonl$/, ".toolresults.json");
}

export async function loadToolResultCache(
  sessionFilePath: string,
): Promise<ToolResultCache> {
  try {
    const json = await readFile(getToolResultCachePath(sessionFilePath), "utf-8");
    const cache = JSON.parse(json) as ToolResultCache;
    if (cache.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return cache;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export async function saveToolResultCache(
  sessionFilePath: string,
  cache: ToolResultCache,
): Promise<void> {
  const cachePath = getToolResultCachePath(sessionFilePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cache Operations
// ═══════════════════════════════════════════════════════════════════════════

/** 查询缓存中是否有某个 turn 的某个 tool result 的截断版本 */
export function getCachedToolResult(
  cache: ToolResultCache,
  turnId: string,
  messageIndex: number,
): CachedToolResult | null {
  const turnCache = cache.entries[turnId];
  if (!turnCache) return null;
  return turnCache.results[messageIndex] ?? null;
}

/** 写入截断结果到缓存 */
export function setCachedToolResult(
  cache: ToolResultCache,
  turnId: string,
  messageIndex: number,
  entry: CachedToolResult,
): void {
  if (!cache.entries[turnId]) {
    cache.entries[turnId] = { results: {} };
  }
  cache.entries[turnId].results[messageIndex] = entry;
}

/** 检查某个 turn 是否有任何已缓存的 tool result 截断 */
export function hasCachedToolResults(
  cache: ToolResultCache,
  turnId: string,
): boolean {
  const turnCache = cache.entries[turnId];
  if (!turnCache) return false;
  return Object.keys(turnCache.results).length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Head + Tail 截断算法
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对文本进行 head+tail 截断。
 *
 * 策略：
 *   1. 检测尾部是否有重要内容（error、exception、summary、JSON 等）
 *   2. 如果尾部重要 → head 60% + tail 30%
 *   3. 如果尾部不重要 → head 80% + tail 10%
 *   4. 在自然断行处切割，避免截断 JSON/代码结构
 *
 * @param text 原始文本
 * @param maxChars 截断后最大字符数
 * @returns 截断后的文本
 */
export function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const budget = Math.max(200, maxChars - TRUNCATION_SUFFIX.length - MIDDLE_OMISSION_MARKER.length);
  const tailImportant = hasImportantTail(text);

  let headRatio: number;
  let tailRatio: number;

  if (tailImportant) {
    headRatio = 0.6;
    tailRatio = 0.3;
  } else {
    headRatio = 0.8;
    tailRatio = 0.1;
  }

  const headBudget = Math.floor(budget * headRatio);
  const tailBudget = Math.floor(budget * tailRatio);

  // 在自然断行处切割 head
  let headCut = headBudget;
  const headNewline = text.lastIndexOf("\n", headBudget);
  if (headNewline > headBudget * 0.8) {
    headCut = headNewline;
  }

  // 在自然断行处切割 tail
  let tailStart = text.length - tailBudget;
  const tailNewline = text.indexOf("\n", tailStart);
  if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
    tailStart = tailNewline + 1;
  }

  const omittedChars = tailStart - headCut;
  const marker = `\n\n⚠️ [... ${omittedChars} chars / ~${Math.round(omittedChars / 4)} tokens omitted — showing head and tail ...]\n\n`;

  return text.slice(0, headCut) + marker + text.slice(tailStart) + TRUNCATION_SUFFIX;
}

/**
 * 检测文本尾部是否包含重要内容。
 * 重要尾部的判定条件（取最后 2000 字符检测）：
 *   - error/exception/failed 等错误关键词
 *   - JSON 闭合大括号（可能是结构化数据结尾）
 *   - total/summary/result 等总结关键词
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done|conclusion)\b/.test(tail)
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Stats
// ═══════════════════════════════════════════════════════════════════════════

export function getToolResultCacheStats(cache: ToolResultCache): {
  totalEntries: number;
  totalTurns: number;
  totalCharsSaved: number;
  totalTokensSaved: number;
} {
  let totalEntries = 0;
  let totalCharsSaved = 0;
  let totalTokensSaved = 0;

  for (const turnCache of Object.values(cache.entries)) {
    for (const entry of Object.values(turnCache.results)) {
      totalEntries++;
      totalCharsSaved += entry.originalChars - entry.truncatedContent.length;
      totalTokensSaved += entry.originalTokens - entry.truncatedTokens;
    }
  }

  return {
    totalEntries,
    totalTurns: Object.keys(cache.entries).length,
    totalCharsSaved,
    totalTokensSaved,
  };
}
