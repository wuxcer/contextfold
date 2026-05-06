/**
 * Topic Compaction Cache — Topic 级别摘要持久化
 *
 * 当所有 turn 属于同一话题、turn-level 压缩后仍超出窗口时，
 * 对最早的若干 topic 做整体压缩。结果缓存到磁盘。
 *
 * 缓存文件：<sessionId>.topic-compaction.json
 *
 * 与 turn-level summaries.json 的区别：
 *   - summaries.json：单个 turn 的摘要
 *   - topic-compaction.json：多个 turn 合并的 topic 级摘要
 *
 * 当 topic compaction 存在时，assemble 阶段优先使用 topic compaction，
 * 不再逐一展开该 topic 下的 turn summaries。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

/** 单个 Topic 的压缩结果 */
export interface TopicCompactionEntry {
  /** topic ID */
  topicId: string;
  /** topic label */
  topicLabel: string;
  /** 合并摘要文本 */
  summary: string;
  /** 摘要 token 数 */
  summaryTokens: number;
  /** 包含的 turn 数量 */
  turnCount: number;
  /** 包含的 turn IDs */
  turnIds: string[];
  /** 压缩前这些 turn 的总 token 数 */
  originalTokens: number;
  /** 生成方式 */
  method: "llm" | "local";
  /** 生成时间 */
  createdAt: string;
}

/** 持久化缓存结构 */
export interface TopicCompactionCache {
  version: number;
  /** topicId → 压缩结果 */
  entries: Record<string, TopicCompactionEntry>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Persistence
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_VERSION = 1;

export function getTopicCompactionCachePath(sessionFilePath: string): string {
  return sessionFilePath.replace(/\.jsonl$/, ".topic-compaction.json");
}

export async function loadTopicCompactionCache(
  sessionFilePath: string,
): Promise<TopicCompactionCache> {
  try {
    const json = await readFile(getTopicCompactionCachePath(sessionFilePath), "utf-8");
    const cache = JSON.parse(json) as TopicCompactionCache;
    if (cache.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return cache;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export async function saveTopicCompactionCache(
  sessionFilePath: string,
  cache: TopicCompactionCache,
): Promise<void> {
  const cachePath = getTopicCompactionCachePath(sessionFilePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cache Operations
// ═══════════════════════════════════════════════════════════════════════════

/** 查询某个 topic 是否有整体压缩 */
export function getTopicCompaction(
  cache: TopicCompactionCache,
  topicId: string,
): TopicCompactionEntry | null {
  return cache.entries[topicId] ?? null;
}

/** 写入 topic 压缩结果 */
export function setTopicCompaction(
  cache: TopicCompactionCache,
  entry: TopicCompactionEntry,
): void {
  cache.entries[entry.topicId] = entry;
}

/** 获取缓存统计 */
export function getTopicCompactionStats(cache: TopicCompactionCache): {
  total: number;
  totalTokensSaved: number;
  totalTurnsCompacted: number;
} {
  let totalTokensSaved = 0;
  let totalTurnsCompacted = 0;

  for (const entry of Object.values(cache.entries)) {
    totalTokensSaved += entry.originalTokens - entry.summaryTokens;
    totalTurnsCompacted += entry.turnCount;
  }

  return {
    total: Object.keys(cache.entries).length,
    totalTokensSaved,
    totalTurnsCompacted,
  };
}
