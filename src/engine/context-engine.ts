/**
 * Turn-Indexed Context Engine
 *
 * 一个基于 Turn 索引的 context engine 插件，接入 OpenClaw 的
 * assemble / compact 生命周期。
 *
 * 核心策略：
 *   1. assemble() 阶段：最近 N 个 Turn 完整保留，更早的 Turn 只放摘要
 *   2. compact() 阶段：为超出窗口的 Turn 生成摘要，但不删除 session 文件原始行
 *   3. 任何时候都能通过 TurnId → 行号范围 恢复原始消息
 *
 * 对话在 session JSONL 中的完整记录永远不丢。
 * "记忆缺失"问题通过摘要 + 按需恢复解决。
 */

import type { TurnIndex, SessionIndex } from "../session-index/types.js";
import { buildSessionIndex } from "../session-index/builder.js";
import { SessionIndexQuery } from "../session-index/query.js";
import { saveIndex, loadIndex, isIndexStale } from "../session-index/persistence.js";
import { estimateTokens } from "../utils/tokens.js";
import {
  loadSummaryCache,
  saveSummaryCache,
  getCachedSummary,
  setCachedSummary,
  getCacheStats,
  type SummaryCache,
  type CachedSummary,
} from "./summary-cache.js";
import {
  detectSubTopicsByLlm,
  detectSubTopicsByHeuristic,
  type SubTopicResult,
  type SubTopic,
} from "../topic/subtopic-detector.js";
import {
  loadSubTopicCache,
  saveSubTopicCache,
} from "../topic/subtopic-cache.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

/** 单条消息（与 OpenClaw AgentMessage 兼容的子集） */
export interface EngineMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** assemble() 的返回结果 */
export interface AssembleResult {
  messages: EngineMessage[];
  tokenCount: number;
}

/** 单个 Turn 的压缩状态 */
export interface TurnCompactionState {
  turnId: string;
  /** 是否已被压缩（摘要替代原始消息） */
  compacted: boolean;
  /** 摘要文本（compacted=true 时有值） */
  summary?: string;
  /** 摘要 token 数 */
  summaryTokens?: number;
  /** 原始 token 数 */
  originalTokens: number;
}

/** engine 的持久化状态 */
export interface EngineState {
  /** sessionId → Turn 压缩状态映射 */
  turnStates: Record<string, TurnCompactionState>;
  /** 上次 compaction 的时间 */
  lastCompactedAt?: string;
}

/** LLM 摘要函数类型 */
export type SummarizeFn = (
  turnContent: string,
  context: string,
) => Promise<string>;

/** engine 配置 */
export interface EngineConfig {
  /** 始终完整保留的最近 Turn 数量 */
  preserveRecentTurns: number;
  /** context window 的 token 上限 */
  maxContextTokens: number;
  /** 触发 compaction 的 token 使用比例 (0-1) */
  compactionThreshold: number;
  /** 系统 prompt 预估 token 数（用于计算可用 token 预算） */
  systemPromptReserve: number;
  /** 单个 tool result 的最大 token 数，超过就截断（头尾保留，中间省略） */
  toolResultMaxTokens: number;
  /**
   * LLM 摘要函数。
   *
   * 提供时：优先用 LLM 生成摘要（质量高）
   * 不提供 / 失败时：回退到本地提取式摘要
   *
   * 摘要一旦生成就缓存到磁盘（summaries.json），
   * 后续 compact 不会重复调用 LLM。
   */
  summarize?: SummarizeFn;
  /**
   * 跨话题 Turn 的压缩策略。
   * "summarize" — 生成 topic 级别的简短摘要（默认）
   * "drop" — 直接丢弃，只保留 topic label
   */
  crossTopicStrategy: "summarize" | "drop";
  /**
   * 同话题内（非当前话题）最多保留的 Turn 数。
   * 超出的按重要性排序压缩。默认 3。
   */
  sameTopicMaxTurns: number;
  /**
   * 是否启用 topic-aware 压缩。
   * 开启后 assemble/compact 会感知话题边界。默认 true。
   */
  topicAwareEnabled: boolean;
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  preserveRecentTurns: 5,
  maxContextTokens: 128_000,
  compactionThreshold: 0.75,
  systemPromptReserve: 10_000,
  toolResultMaxTokens: 500,
  crossTopicStrategy: "summarize",
  sameTopicMaxTurns: 3,
  topicAwareEnabled: true,
};

// ═══════════════════════════════════════════════════════════════════════════
//  Turn-Indexed Context Engine
// ═══════════════════════════════════════════════════════════════════════════

export class TurnIndexedContextEngine {
  private config: EngineConfig;
  private state: EngineState;
  private indexCache = new Map<string, { index: SessionIndex; query: SessionIndexQuery }>();
  /** 子话题检测缓存：topicId → SubTopicResult */
  private subtopicCache = new Map<string, SubTopicResult>();

  constructor(config: Partial<EngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };
    this.state = { turnStates: {} };
  }

  // ── 索引管理 ──────────────────────────────────────────────────────────

  /**
   * 获取或构建 session 索引。
   */
  async getIndex(sessionFile: string): Promise<{ index: SessionIndex; query: SessionIndexQuery }> {
    const cached = this.indexCache.get(sessionFile);
    if (cached && !(await isIndexStale(sessionFile, cached.index))) {
      return cached;
    }

    let index = await loadIndex(sessionFile);
    if (index && await isIndexStale(sessionFile, index)) {
      index = await buildSessionIndex(sessionFile, index);
      await saveIndex(sessionFile, index);
    } else if (!index) {
      index = await buildSessionIndex(sessionFile);
      await saveIndex(sessionFile, index);
    }

    const entry = { index, query: new SessionIndexQuery(index) };
    this.indexCache.set(sessionFile, entry);
    return entry;
  }

  // ── assemble：组装发送给模型的消息列表 ────────────────────────────────

  /**
   * 组装 context：决定哪些 Turn 完整保留、哪些用摘要替代。
   *
   * Topic-aware 策略：
   *   1. 识别当前话题（最后一个 active topic）
   *   2. 最近 preserveRecentTurns 个 Turn → 完整保留
   *   3. 同话题的更早 Turn → 保留最多 sameTopicMaxTurns 个的摘要
   *   4. 跨话题的 Turn → 按 crossTopicStrategy 处理：
   *      - "summarize": 每个话题生成一行 topic 级摘要
   *      - "drop": 只保留 topic label，不保留任何 turn 内容
   *   5. 返回组装后的 messages + tokenCount
   *
   * 降级：topicAwareEnabled=false 或 topics 只有 1 个时，回退到原有策略。
   */
  async assemble(
    sessionFile: string,
    allMessages: EngineMessage[],
  ): Promise<AssembleResult> {
    const { query } = await this.getIndex(sessionFile);
    const turns = query.getAllTurns();

    if (turns.length === 0) {
      return {
        messages: allMessages,
        tokenCount: estimateMessagesTokens(allMessages),
      };
    }

    const tokenBudget =
      this.config.maxContextTokens - this.config.systemPromptReserve;
    const preserveCount = this.config.preserveRecentTurns;
    const recentCutoff = Math.max(0, turns.length - preserveCount);

    const result: EngineMessage[] = [];
    let usedTokens = 0;

    // ── 获取 topic 信息 ──────────────────────────────────────────────
    const topics = query.getActiveTopics();
    const allTopics = query.getAllTopics ? query.getAllTopics() : topics;
    const useTopicAware =
      this.config.topicAwareEnabled && allTopics.length > 1;

    // 当前话题 = 最后一个 Turn 所属的 topic
    const currentTopicId = turns[turns.length - 1]?.topicId;

    // Phase 1: 构建历史摘要
    if (useTopicAware) {
      // ── Topic-aware 模式 ───────────────────────────────────────────
      const historySections: string[] = [];

      // 按 topic 分组旧 Turn（recentCutoff 之前的）
      const oldTurns = turns.slice(0, recentCutoff);
      const topicGroups = groupTurnsByTopic(oldTurns);

      for (const [topicId, groupTurns] of topicGroups) {
        const topic = allTopics.find((t) => t.id === topicId);
        const topicLabel = topic?.label ?? "unknown";
        const isSameTopic = topicId === currentTopicId;

        if (isSameTopic) {
          // 同话题的旧 Turn：按子话题分组处理
          // 加载子话题缓存
          const subtopicResult = this.subtopicCache.get(topicId);
          
          if (subtopicResult && subtopicResult.subtopics.length > 1) {
            // 有子话题分段：当前子话题保留摘要，旧子话题只保留标签
            const seqSet = new Set(groupTurns.map((t) => t.sequence));
            
            for (const sub of subtopicResult.subtopics) {
              const subTurns = sub.turnSequences
                .filter((seq) => seqSet.has(seq))
                .map((seq) => groupTurns.find((t) => t.sequence === seq))
                .filter((t): t is TurnIndex => t !== undefined);
              
              if (subTurns.length === 0) continue;
              
              if (sub.isCurrent) {
                // 当前子话题：保留 turn 级摘要
                for (const turn of subTurns.slice(-this.config.sameTopicMaxTurns)) {
                  const turnState = this.state.turnStates[turn.id];
                  if (turnState?.compacted && turnState.summary) {
                    historySections.push(turnState.summary);
                    usedTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
                  } else {
                    const line = `[Turn #${turn.sequence}: ${turn.userPreview.slice(0, 80)} → ${turn.assistantPreview.slice(0, 80)}]`;
                    historySections.push(line);
                    usedTokens += 30;
                  }
                }
              } else {
                // 旧子话题：只保留一行标签
                historySections.push(
                  `[Sub-topic: ${sub.label} — ${subTurns.length} turns, completed]`,
                );
                usedTokens += 15;
              }
            }
          } else {
            // 没有子话题分段：回退到原来的保留最近 N 个
            const kept = groupTurns.slice(-this.config.sameTopicMaxTurns);
            for (const turn of kept) {
              const turnState = this.state.turnStates[turn.id];
              if (turnState?.compacted && turnState.summary) {
                historySections.push(turnState.summary);
                usedTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
              } else {
                const line = `[Turn #${turn.sequence}: ${turn.userPreview.slice(0, 80)} → ${turn.assistantPreview.slice(0, 80)}]`;
                historySections.push(line);
                usedTokens += 30;
              }
            }
            if (groupTurns.length > kept.length) {
              const skipped = groupTurns.length - kept.length;
              historySections.unshift(
                `[...${skipped} earlier turns in same topic "${topicLabel}" omitted]`,
              );
              usedTokens += 15;
            }
          }
        } else {
          // 跨话题 Turn：按策略处理
          if (this.config.crossTopicStrategy === "drop") {
            historySections.push(
              `[Topic: ${topicLabel} — ${groupTurns.length} turns, completed]`,
            );
            usedTokens += 15;
          } else {
            // "summarize": topic 级摘要
            const topicSummary = buildTopicSummaryLine(topicLabel, groupTurns, this.state);
            historySections.push(topicSummary);
            usedTokens += estimateTokens(topicSummary);
          }
        }
      }

      if (historySections.length > 0) {
        const summaryBlock = [
          `[Context Summary — ${allTopics.length} topics detected, ${recentCutoff} earlier turns compacted]`,
          ...historySections,
          `[End of summary — current topic continues below]`,
        ].join("\n");
        result.push({ role: "user", content: summaryBlock });
        result.push({ role: "assistant", content: "Understood. I have the context summary of earlier conversation turns. Continuing with the current discussion." });
      }
    } else {
      // ── 原有模式（单 topic 或 topic-aware 关闭）──────────────────
      const historySummaries: string[] = [];

      for (let i = 0; i < recentCutoff; i++) {
        const turn = turns[i];
        const turnState = this.state.turnStates[turn.id];

        if (turnState?.compacted && turnState.summary) {
          historySummaries.push(turnState.summary);
          usedTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
        } else {
          historySummaries.push(
            `[Turn #${turn.sequence}: ${turn.userPreview.slice(0, 80)} → ${turn.assistantPreview.slice(0, 80)}]`,
          );
          usedTokens += 30;
        }
      }

      if (historySummaries.length > 0) {
        const summaryBlock = [
          `[Context Summary — ${historySummaries.length} earlier turns compacted]`,
          ...historySummaries,
          `[End of summary — recent conversation follows]`,
        ].join("\n");
        result.push({ role: "user", content: summaryBlock });
        result.push({ role: "assistant", content: "Understood. I have the context summary of earlier conversation turns. Continuing with the current discussion." });
        usedTokens += estimateTokens(summaryBlock);
      }
    }

    // Phase 2: 最近 N 个 Turn — 保留对话骨架，裁剪大体积 tool result
    if (recentCutoff < turns.length) {
      let recentMessageCount = 0;
      for (let i = recentCutoff; i < turns.length; i++) {
        recentMessageCount += turns[i].messageCount;
      }

      const recentMessages = allMessages.slice(-recentMessageCount);

      // 去重跟踪：连续重复的 tool result 只保留第一次
      const seenToolResults = new Map<string, number>();

      for (const msg of recentMessages) {
        const trimmed = trimMessageForContext(msg, this.config.toolResultMaxTokens);

        // 检测重复的 tool result
        if (trimmed.role === "tool" && typeof trimmed.content === "string") {
          const key = trimmed.content.slice(0, 200);
          const count = seenToolResults.get(key) ?? 0;
          seenToolResults.set(key, count + 1);
          if (count > 0) {
            // 重复的 tool result 压缩为一行
            const deduped: EngineMessage = {
              ...trimmed,
              content: `(same as above, repeated ${count + 1}x)`,
            };
            result.push(deduped);
            usedTokens += 10;
            continue;
          }
        }

        const msgTokens = estimateMessageTokens(trimmed);

        if (usedTokens + msgTokens > tokenBudget) {
          if (trimmed.role === "user" || trimmed.role === "assistant") {
            result.push(trimmed);
            usedTokens += msgTokens;
          }
          continue;
        }

        result.push(trimmed);
        usedTokens += msgTokens;
      }
    }

    return {
      messages: result,
      tokenCount: usedTokens,
    };
  }

  // ── compact：压缩旧 Turn，生成摘要 ───────────────────────────────────

  /**
   * 对旧 Turn 执行压缩。
   *
   * 流程：
   *   1. 加载磁盘摘要缓存
   *   2. 找出需要压缩的 Turn（超出 preserveRecentTurns 且未缓存）
   *   3. 对每个未缓存的 Turn：
   *      a. 有 LLM summarize → 调 LLM 生成摘要
   *      b. LLM 失败 / 未配置 → 本地提取式摘要
   *   4. 写入缓存 + 更新内存状态
   *   5. 保存缓存到磁盘
   *
   * 已缓存的 Turn 永远不会重新调用 LLM。
   *
   * 返回被压缩的 Turn 数量。
   */
  async compact(sessionFile: string): Promise<{
    compactedCount: number;
    tokensSaved: number;
    llmCalls: number;
    cacheHits: number;
  }> {
    const { query } = await this.getIndex(sessionFile);
    const turns = query.getAllTurns();
    const preserveCount = this.config.preserveRecentTurns;
    const compactCutoff = Math.max(0, turns.length - preserveCount);

    // 加载磁盘缓存
    const cache = await loadSummaryCache(sessionFile);

    let compactedCount = 0;
    let tokensSaved = 0;
    let llmCalls = 0;
    let cacheHits = 0;
    let dirty = false;

    for (let i = 0; i < compactCutoff; i++) {
      const turn = turns[i];

      // ── 检查磁盘缓存 ──
      const cached = getCachedSummary(cache, turn.id);
      if (cached) {
        // 缓存命中：直接用缓存，不调 LLM
        this.state.turnStates[turn.id] = {
          turnId: turn.id,
          compacted: true,
          summary: cached.summary,
          summaryTokens: cached.tokens,
          originalTokens: cached.originalTokens,
        };
        cacheHits++;
        compactedCount++;
        tokensSaved += cached.originalTokens - cached.tokens;
        continue;
      }

      // ── 生成摘要 ──
      const rawLines = await query.readTurnRaw(turn.id);

      // 构建给 LLM 的输入：只取关键信息，避免发送大量 tool output
      const turnContent = buildCompactInput(turn, rawLines);

      let summary: string;
      let method: "local" | "llm" = "local";

      if (this.config.summarize) {
        try {
          summary = await this.config.summarize(
            turnContent,
            `Turn #${turn.sequence}: user asked "${turn.userPreview.slice(0, 100)}"`,
          );
          method = "llm";
          llmCalls++;
        } catch {
          // LLM 失败，回退到本地提取
          summary = buildLocalSummary(turn, rawLines);
        }
      } else {
        summary = buildLocalSummary(turn, rawLines);
      }

      const summaryTokens = estimateTokens(summary);

      // ── 写入缓存 ──
      const cacheEntry: CachedSummary = {
        summary,
        tokens: summaryTokens,
        createdAt: new Date().toISOString(),
        method,
        originalTokens: turn.totalTokens,
      };
      setCachedSummary(cache, turn.id, cacheEntry);
      dirty = true;

      // ── 更新内存状态 ──
      this.state.turnStates[turn.id] = {
        turnId: turn.id,
        compacted: true,
        summary,
        summaryTokens,
        originalTokens: turn.totalTokens,
      };

      compactedCount++;
      tokensSaved += turn.totalTokens - summaryTokens;
    }

    // 保存缓存到磁盘
    if (dirty) {
      await saveSummaryCache(sessionFile, cache);
    }

    if (compactedCount > 0) {
      this.state.lastCompactedAt = new Date().toISOString();
    }

    // ── 子话题检测（compact 后触发）──────────────────────────────
    if (this.config.topicAwareEnabled && compactedCount > 0) {
      await this.runSubTopicDetection(sessionFile);
    }

    return { compactedCount, tokensSaved, llmCalls, cacheHits };
  }

  /**
   * 对每个大话题运行子话题检测。
   * 结果缓存到内存和磁盘。
   */
  private async runSubTopicDetection(sessionFile: string): Promise<void> {
    const { query } = await this.getIndex(sessionFile);
    const allTopics = query.getAllTopics();
    const turns = query.getAllTurns();
    const subtopicDiskCache = await loadSubTopicCache(sessionFile);
    let dirty = false;

    for (const topic of allTopics) {
      // 跳过已缓存的（除非 turn 数量变了）
      const cached = subtopicDiskCache.entries[topic.id];
      if (cached) {
        const cachedTurnCount = cached.subtopics.reduce(
          (sum, s) => sum + s.turnSequences.length, 0,
        );
        if (cachedTurnCount === topic.turnIds.length) {
          this.subtopicCache.set(topic.id, cached);
          continue;
        }
      }

      // 取该 topic 下的 turns
      const topicTurns = topic.turnIds
        .map((id) => turns.find((t) => t.id === id))
        .filter((t): t is TurnIndex => t !== undefined);

      if (topicTurns.length < 3) {
        // 太少不值得分子话题
        continue;
      }

      let result: SubTopicResult;
      if (this.config.summarize) {
        // 复用 summarize 函数作为 LLM classify
        result = await detectSubTopicsByLlm(
          topic.id,
          topicTurns,
          this.config.summarize,
        );
      } else {
        result = detectSubTopicsByHeuristic(topic.id, topicTurns);
      }

      this.subtopicCache.set(topic.id, result);
      subtopicDiskCache.entries[topic.id] = result;
      dirty = true;
    }

    if (dirty) {
      await saveSubTopicCache(sessionFile, subtopicDiskCache);
    }
  }

  // ── 按需恢复：通过 TurnId 恢复完整消息 ───────────────────────────────

  /**
   * 恢复某个已压缩 Turn 的完整原始消息。
   * 用于模型需要回顾某轮对话细节时。
   */
  async recoverTurn(
    sessionFile: string,
    turnId: string,
  ): Promise<{ messages: Record<string, unknown>[]; lineRange: { lineStart: number; lineEnd: number } } | null> {
    const { query } = await this.getIndex(sessionFile);
    const range = query.getTurnLineRange(turnId);
    if (!range) return null;

    const messages = await query.readTurnMessages(turnId);
    return { messages, lineRange: range };
  }

  // ── 状态查询 ──────────────────────────────────────────────────────────

  /** 检查是否需要 compaction */
  async needsCompaction(sessionFile: string): Promise<boolean> {
    const { query } = await this.getIndex(sessionFile);
    const stats = query.getStats();
    const threshold =
      (this.config.maxContextTokens - this.config.systemPromptReserve) *
      this.config.compactionThreshold;
    return stats.totalTokens > threshold;
  }

  /** 获取压缩统计 */
  getCompactionStats(): {
    totalCompacted: number;
    totalSaved: number;
    lastCompactedAt: string | undefined;
  } {
    let totalCompacted = 0;
    let totalSaved = 0;
    for (const state of Object.values(this.state.turnStates)) {
      if (state.compacted) {
        totalCompacted++;
        totalSaved += state.originalTokens - (state.summaryTokens ?? 0);
      }
    }
    return {
      totalCompacted,
      totalSaved,
      lastCompactedAt: this.state.lastCompactedAt,
    };
  }

  /** 获取或设置 engine state（用于持久化） */
  getState(): EngineState {
    return structuredClone(this.state);
  }

  setState(state: EngineState): void {
    this.state = structuredClone(state);
  }

  /** 更新配置 */
  updateConfig(config: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): EngineConfig {
    return { ...this.config };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════════════════

// ── Topic-aware helpers ──────────────────────────────────────────────────

/**
 * 按 topicId 将 Turn 列表分组。
 * 返回 Map<topicId, TurnIndex[]>，保持原始顺序。
 */
function groupTurnsByTopic(turns: TurnIndex[]): Map<string, TurnIndex[]> {
  const groups = new Map<string, TurnIndex[]>();
  for (const turn of turns) {
    const id = turn.topicId || "__default__";
    const arr = groups.get(id);
    if (arr) {
      arr.push(turn);
    } else {
      groups.set(id, [turn]);
    }
  }
  return groups;
}

/**
 * 为一个跨话题的 Topic 构建一行摘要。
 * 格式：[Topic: <label> — N turns | 关键操作/工具/结论]
 */
function buildTopicSummaryLine(
  topicLabel: string,
  groupTurns: TurnIndex[],
  state: EngineState,
): string {
  const turnCount = groupTurns.length;
  const toolsUsed = new Set<string>();
  const summaryParts: string[] = [];

  for (const turn of groupTurns) {
    for (const tool of turn.toolsUsed) {
      toolsUsed.add(tool);
    }
    // 如果有 compacted 摘要，取第一行作为要点
    const turnState = state.turnStates[turn.id];
    if (turnState?.compacted && turnState.summary) {
      const firstLine = turnState.summary.split("\n")[0].slice(0, 60);
      if (firstLine) summaryParts.push(firstLine);
    }
  }

  const toolStr = toolsUsed.size > 0 ? ` | tools: ${[...toolsUsed].slice(0, 5).join(", ")}` : "";
  const highlights = summaryParts.length > 0
    ? ` | highlights: ${summaryParts.slice(0, 2).join("; ")}`
    : "";

  return `[Topic: ${topicLabel} — ${turnCount} turns${toolStr}${highlights}]`;
}

function estimateMessageTokens(msg: EngineMessage): number {
  if (typeof msg.content === "string") {
    return estimateTokens(msg.content);
  }
  if (Array.isArray(msg.content)) {
    return msg.content.reduce((sum, part) => {
      if (typeof part.text === "string") return sum + estimateTokens(part.text);
      return sum + 10; // 非文本 part 给个最小估算
    }, 0);
  }
  return 0;
}

function estimateMessagesTokens(msgs: EngineMessage[]): number {
  return msgs.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ── Tool Result 智能裁剪 ─────────────────────────────────────────

/** tool result 的默认最大 token 数 */
const DEFAULT_TOOL_RESULT_MAX_TOKENS = 800;

/**
 * 对单条消息做智能裁剪：
 *   - user / assistant 消息：不截断（这是对话的核心意图和结果）
 *   - tool result：截断到 maxTokens
 *     因为 tool 输出通常是大段文件内容、命令输出、错误堆栈，
 *     头尾部分足够理解上下文，中间可以省略。
 */
function trimMessageForContext(
  msg: EngineMessage,
  maxTokens: number = DEFAULT_TOOL_RESULT_MAX_TOKENS,
): EngineMessage {
  // user 消息：strip Sender metadata 前缀（节省 token）
  if (msg.role === "user") {
    const stripped = stripSenderMetadataFromContent(msg.content);
    if (stripped !== msg.content) {
      return { ...msg, content: stripped as string | Array<{ type: string; text?: string; [key: string]: unknown }> };
    }
    return msg;
  }

  // assistant 不裁剪
  if (msg.role === "assistant") {
    return msg;
  }

  // tool result 裁剪
  const currentTokens = estimateMessageTokens(msg);

  if (currentTokens <= maxTokens) {
    return msg; // 不需要裁剪
  }

  // 截断策略：保留头部 + 尾部，中间用省略标记
  if (typeof msg.content === "string") {
    return {
      ...msg,
      content: truncateHeadTail(msg.content, maxTokens),
    };
  }

  if (Array.isArray(msg.content)) {
    const trimmed = msg.content.map((part) => {
      if (typeof part.text === "string" && estimateTokens(part.text) > maxTokens) {
        return { ...part, text: truncateHeadTail(part.text, maxTokens) };
      }
      return part;
    });
    return { ...msg, content: trimmed };
  }

  return msg;
}

/**
 * 头尾截断：保留前 60% 和后 30% 的 token，中间用省略标记。
 * 这样上下文两头都能看到，中间重复部分被省略。
 */
function truncateHeadTail(text: string, maxTokens: number): string {
  // 粗略估算：1 token ≈ 4 chars
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);
  const omitted = text.length - headChars - tailChars;

  return (
    text.slice(0, headChars) +
    `\n\n... [${omitted} chars omitted, ~${Math.round(omitted / 4)} tokens] ...\n\n` +
    text.slice(-tailChars)
  );
}

/**
 * 本地提取式摘要：从 Turn 的原始消息中提取关键信息。
 * 不依赖 LLM，纯规则提取。
 */
function buildLocalSummary(turn: TurnIndex, _rawLines: string[]): string {
  const parts: string[] = [];

  parts.push(`User: ${turn.userPreview}`);

  if (turn.toolsUsed.length > 0) {
    parts.push(`Tools: ${turn.toolsUsed.join(", ")}`);
  }

  if (turn.assistantPreview) {
    parts.push(`Assistant: ${turn.assistantPreview}`);
  }

  if (turn.hasError) {
    parts.push(`⚠️ This turn had tool errors`);
  }

  parts.push(`(${turn.messageCount} messages, lines ${turn.lineStart}-${turn.lineEnd})`);

  return parts.join("\n");
}

/**
 * 构建给 LLM 的精简输入。
 *
 * 不发送完整的 tool output（往往数万字符），只发：
 *   - 用户消息全文
 *   - 助手文本回复全文
 *   - 工具名称 + 参数摘要 + 结果摘要（前200字）
 *   - 错误信息
 *
 * 这样 LLM 能理解这轮做了什么，但不会被大量文件内容淡化注意力。
 * 同时也避免了发送大量 token，控制摘要调用的 KV cache 成本。
 */
function buildCompactInput(turn: TurnIndex, rawLines: string[]): string {
  const parts: string[] = [];

  parts.push(`[Turn #${turn.sequence} | ${turn.messageCount} messages | ${turn.toolsUsed.length} tools]`);
  parts.push(``);

  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "message") continue;
      const msg = obj.message;

      if (msg.role === "user") {
        // 用户消息：全文保留（通常不长）
        const text = extractText(msg.content);
        parts.push(`[User]: ${text}`);
      } else if (msg.role === "assistant") {
        const text = extractText(msg.content);
        const toolCalls = extractToolCalls(msg.content);
        if (text) {
          parts.push(`[Assistant]: ${text}`);
        }
        if (toolCalls.length > 0) {
          parts.push(`[ToolCalls]: ${toolCalls.join(", ")}`);
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(msg.content);
        const preview = text.slice(0, 200);
        const suffix = text.length > 200 ? `... [${text.length} chars total]` : "";
        const err = msg.isError ? " ❌ ERROR" : "";
        parts.push(`[Tool ${msg.toolName || "?"}${err}]: ${preview}${suffix}`);
      }
    } catch {
      // 解析失败，跳过
    }
  }

  return parts.join("\n");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: Record<string, unknown>) => p.type === "text")
      .map((p: Record<string, unknown>) => p.text || "")
      .join("");
  }
  return "";
}

function extractToolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: Record<string, unknown>) => p.type === "toolCall")
    .map((p: Record<string, unknown>) => {
      const name = p.name || "?";
      const args = JSON.stringify(p.arguments || {}).slice(0, 100);
      return `${name}(${args})`;
    });
}

// ── Sender Metadata Stripping ────────────────────────────────────────

const SENDER_META_RE = /^Sender\s*\(untrusted metadata\):\n```json\n[\s\S]*?```\n*/;
const TIMESTAMP_RE = /^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/;
const INTERNAL_CTX_RE = /^<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\s*/;

function stripMetadataFromText(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(SENDER_META_RE, "");
  cleaned = cleaned.replace(TIMESTAMP_RE, "");
  cleaned = cleaned.replace(INTERNAL_CTX_RE, "");
  return cleaned;
}

function stripSenderMetadataFromContent(content: unknown): unknown {
  if (typeof content === "string") {
    const stripped = stripMetadataFromText(content);
    return stripped.trim() || content;
  }
  if (Array.isArray(content)) {
    return content.map((part: Record<string, unknown>) => {
      if (part.type === "text" && typeof part.text === "string") {
        const stripped = stripMetadataFromText(part.text);
        return { ...part, text: stripped.trim() || part.text };
      }
      return part;
    });
  }
  return content;
}
