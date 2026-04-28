/**
 * Session Index Query
 *
 * 基于 Turn 行号范围的查询 API。
 * 核心能力：通过 TurnId 定位行号范围，从 session 文件恢复原始消息。
 */

import { readFile } from "node:fs/promises";
import type {
  SessionIndex,
  TurnIndex,
  TopicIndex,
} from "./types.js";
import { formatTokenCount } from "../utils/tokens.js";

export class SessionIndexQuery {
  constructor(private index: SessionIndex) {}

  // ── Turn 查询 ─────────────────────────────────────────────────────────

  /** 按 ID 获取 Turn */
  getTurn(turnId: string): TurnIndex | undefined {
    const idx = this.index.turnById[turnId];
    return idx !== undefined ? this.index.turns[idx] : undefined;
  }

  /** 按序号获取 Turn */
  getTurnBySequence(seq: number): TurnIndex | undefined {
    return this.index.turns[seq];
  }

  /** 获取全部 Turns */
  getAllTurns(): TurnIndex[] {
    return this.index.turns;
  }

  /** 获取最近 N 个 Turns */
  getRecentTurns(count: number): TurnIndex[] {
    return this.index.turns.slice(-count);
  }

  /** 获取 token 数最大的 N 个 Turns */
  getLargestTurns(count: number): TurnIndex[] {
    return [...this.index.turns]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, count);
  }

  /** 获取使用了特定工具的 Turns */
  getTurnsByTool(toolName: string): TurnIndex[] {
    return this.index.turns.filter((t) => t.toolsUsed.includes(toolName));
  }

  // ── 行号范围 → 原始消息恢复 ──────────────────────────────────────────

  /**
   * 通过 TurnId 获取行号范围。
   * 这是索引的核心用途：压缩后通过行号范围恢复原始消息。
   */
  getTurnLineRange(turnId: string): { lineStart: number; lineEnd: number } | undefined {
    const turn = this.getTurn(turnId);
    if (!turn) return undefined;
    return { lineStart: turn.lineStart, lineEnd: turn.lineEnd };
  }

  /**
   * 从 session 文件中读取指定行号范围的原始 JSONL 行。
   * lineStart/lineEnd 均为 1-based, inclusive。
   */
  async readLines(lineStart: number, lineEnd: number): Promise<string[]> {
    const content = await readFile(this.index.meta.sessionFile, "utf-8");
    const allLines = content.split("\n");
    // 1-based → 0-based
    return allLines.slice(lineStart - 1, lineEnd);
  }

  /**
   * 通过 TurnId 恢复该轮的全部原始 JSONL 消息。
   */
  async readTurnRaw(turnId: string): Promise<string[]> {
    const range = this.getTurnLineRange(turnId);
    if (!range) return [];
    return this.readLines(range.lineStart, range.lineEnd);
  }

  /**
   * 通过 TurnId 恢复该轮消息并解析为 JSON 对象。
   */
  async readTurnMessages(turnId: string): Promise<Record<string, unknown>[]> {
    const lines = await this.readTurnRaw(turnId);
    const messages: Record<string, unknown>[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === "message") {
          messages.push(obj);
        }
      } catch {
        // skip
      }
    }
    return messages;
  }

  // ── Topic 查询 ────────────────────────────────────────────────────────

  /** 获取所有 Topics */
  getAllTopics(): TopicIndex[] {
    return this.index.topics;
  }

  /** 获取活跃 Topics */
  getActiveTopics(): TopicIndex[] {
    return this.index.topics.filter((t) => t.status === "active");
  }

  /** 获取某个 Topic 下的 Turns */
  getTopicTurns(topicId: string): TurnIndex[] {
    const topic = this.index.topics.find((t) => t.id === topicId);
    if (!topic) return [];
    return topic.turnIds
      .map((id) => this.getTurn(id))
      .filter((t): t is TurnIndex => t !== undefined);
  }

  // ── 压缩决策 ─────────────────────────────────────────────────────────

  /**
   * 获取可压缩的 Turns（排除最近 N 轮），按重要性升序（低分优先压缩）。
   */
  getCompressibleTurns(preserveRecent: number = 5): TurnIndex[] {
    const cutoff = Math.max(0, this.index.turns.length - preserveRecent);
    return this.index.turns
      .slice(0, cutoff)
      .sort((a, b) => a.importance - b.importance);
  }

  /**
   * 推荐压缩方案：选择哪些 Turns 压缩可使 token 降到目标值以下。
   */
  recommendCompression(
    targetTokens: number,
    preserveRecent: number = 5,
  ): { turnIds: string[]; estimatedSavings: number } {
    const total = this.index.stats.totalTokens;
    if (total <= targetTokens) {
      return { turnIds: [], estimatedSavings: 0 };
    }

    const candidates = this.getCompressibleTurns(preserveRecent);
    const selected: string[] = [];
    let saved = 0;
    const need = total - targetTokens;

    for (const turn of candidates) {
      if (saved >= need) break;
      selected.push(turn.id);
      saved += Math.floor(turn.totalTokens * 0.85); // 假设压缩保留 15%
    }

    return { turnIds: selected, estimatedSavings: saved };
  }

  // ── 格式化输出 ────────────────────────────────────────────────────────

  getStats() {
    return this.index.stats;
  }

  getMeta() {
    return this.index.meta;
  }

  formatOverview(): string {
    const s = this.index.stats;
    const m = this.index.meta;
    const lines = [
      `📑 Session Index`,
      `├─ Session: ${m.sessionId.slice(0, 8)}...`,
      `├─ Model: ${m.currentModel.provider}/${m.currentModel.modelId}`,
      `├─ Turns: ${s.totalTurns}`,
      `├─ Messages: ${s.totalMessages}`,
      `├─ Tokens: ~${formatTokenCount(s.totalTokens)}`,
      `├─ Tool calls: ${s.totalToolCalls}`,
      `├─ Lines indexed: ${s.totalLines}`,
    ];

    if (Object.keys(s.toolCallsByName).length > 0) {
      const sorted = Object.entries(s.toolCallsByName).sort(([, a], [, b]) => b - a);
      lines.push(`└─ Tools: ${sorted.map(([n, c]) => `${n}(${c})`).join(", ")}`);
    }

    return lines.join("\n");
  }

  formatTurnList(): string {
    return this.index.turns
      .map(
        (t) =>
          `#${t.sequence} [${t.id}] lines ${t.lineStart}-${t.lineEnd} | ${t.messageCount} msgs | ${formatTokenCount(t.totalTokens)} tokens | imp=${t.importance} | tools:[${t.toolsUsed.join(",")}]${t.hasError ? " ⚠️" : ""}` +
          `\n  user: ${t.userPreview.slice(0, 80)}` +
          `\n  asst: ${t.assistantPreview.slice(0, 80)}`,
      )
      .join("\n\n");
  }
}
