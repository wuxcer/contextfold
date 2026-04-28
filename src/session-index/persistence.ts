/**
 * Session Index Persistence
 *
 * 索引文件与 session JSONL 同目录，命名为 <sessionId>.index.json。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { stat } from "node:fs/promises";
import type { SessionIndex } from "./types.js";

const INDEX_VERSION = 1;

export function getIndexFilePath(sessionFilePath: string): string {
  return sessionFilePath.replace(/\.jsonl$/, ".index.json");
}

export async function saveIndex(
  sessionFilePath: string,
  index: SessionIndex,
): Promise<string> {
  const indexPath = getIndexFilePath(sessionFilePath);
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index), "utf-8");
  return indexPath;
}

export async function loadIndex(
  sessionFilePath: string,
): Promise<SessionIndex | null> {
  try {
    const json = await readFile(getIndexFilePath(sessionFilePath), "utf-8");
    const index = JSON.parse(json) as SessionIndex;
    if (index.version !== INDEX_VERSION) return null;
    return index;
  } catch {
    return null;
  }
}

export async function isIndexStale(
  sessionFilePath: string,
  index: SessionIndex,
): Promise<boolean> {
  try {
    const s = await stat(sessionFilePath);
    return s.mtime.toISOString() !== index.sessionFileModifiedAt;
  } catch {
    return true;
  }
}
