/**
 * Sub-topic Cache — 子话题检测结果持久化
 *
 * 子话题检测结果缓存到磁盘，避免重复调用 LLM。
 * 缓存文件：<sessionId>.subtopics.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { SubTopicResult } from "./subtopic-detector.js";

export interface SubTopicCache {
  version: number;
  /** topicId → 子话题检测结果 */
  entries: Record<string, SubTopicResult>;
}

const CACHE_VERSION = 1;

export function getSubTopicCachePath(sessionFilePath: string): string {
  return sessionFilePath.replace(/\.jsonl$/, ".subtopics.json");
}

export async function loadSubTopicCache(
  sessionFilePath: string,
): Promise<SubTopicCache> {
  try {
    const json = await readFile(getSubTopicCachePath(sessionFilePath), "utf-8");
    const cache = JSON.parse(json) as SubTopicCache;
    if (cache.version !== CACHE_VERSION) {
      return { version: CACHE_VERSION, entries: {} };
    }
    return cache;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

export async function saveSubTopicCache(
  sessionFilePath: string,
  cache: SubTopicCache,
): Promise<void> {
  const cachePath = getSubTopicCachePath(sessionFilePath);
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}
