/**
 * Summary Cache — 摘要持久化
 *
 * 摘要生成后缓存到磁盘，避免重复调用 LLM。
 * 缓存文件与 session JSONL 同目录：<sessionId>.summaries.json
 *
 * 缓存结构：{ turnId: { summary, tokens, createdAt, method } }
 *   method: "local" | "llm" — 区分本地提取还是 LLM 生成
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CachedSummary {
  /** 摘要文本 */
  summary: string;
  /** 摘要 token 数 */
  tokens: number;
  /** 生成时间 */
  createdAt: string;
  /** 生成方式 */
  method: "local" | "llm";
  /** 原始 Turn 的 token 数（用于计算 tokensSaved） */
  originalTokens: number;
}

export interface SummaryCache {
  version: number;
  /** turnId → 缓存的摘要 */
  entries: Record<string, CachedSummary>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 1;

export function getSummaryCachePath(sessionFilePath: string): string {
  return sessionFilePath.replace(/\.jsonl$/, ".summaries.json");
}

export async function loadSummaryCache(
  sessionFilePath: string,
): Promise<SummaryCache> {
  try {
    const json = await readFile(getSummaryCachePath(sessionFilePath), "utf-8");
    const cache = JSON.parse(json) as SummaryCache;
    if (cache.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return cache;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export async function saveSummaryCache(
  sessionFilePath: string,
  cache: SummaryCache,
): Promise<void> {
  const cachePath = getSummaryCachePath(sessionFilePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cache Operations
// ═══════════════════════════════════════════════════════════════════════════

/** 查询缓存中是否已有某个 Turn 的摘要 */
export function getCachedSummary(
  cache: SummaryCache,
  turnId: string,
): CachedSummary | null {
  return cache.entries[turnId] ?? null;
}

/** 写入一条摘要到缓存（内存中，需要后续调 saveSummaryCache 持久化） */
export function setCachedSummary(
  cache: SummaryCache,
  turnId: string,
  entry: CachedSummary,
): void {
  cache.entries[turnId] = entry;
}

/** 获取缓存统计 */
export function getCacheStats(cache: SummaryCache): {
  total: number;
  llm: number;
  local: number;
  totalTokensSaved: number;
} {
  let llm = 0;
  let local = 0;
  let totalTokensSaved = 0;

  for (const entry of Object.values(cache.entries)) {
    if (entry.method === "llm") llm++;
    else local++;
    totalTokensSaved += entry.originalTokens - entry.tokens;
  }

  return {
    total: llm + local,
    llm,
    local,
    totalTokensSaved,
  };
}
