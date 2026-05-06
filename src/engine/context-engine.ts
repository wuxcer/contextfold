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

import type { TurnIndex, SessionIndex, TopicIndex } from "../session-index/types.js";
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
  loadToolResultCache,
  saveToolResultCache,
  getCachedToolResult,
  setCachedToolResult,
  truncateHeadTail,
  type ToolResultCache,
} from "./tool-result-cache.js";
import {
  loadTopicCompactionCache,
  saveTopicCompactionCache,
  getTopicCompaction,
  setTopicCompaction,
  type TopicCompactionCache,
  type TopicCompactionEntry,
} from "./topic-compaction-cache.js";
import {
  type SubTopicResult,
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
   * 非保护区 turn 中单个 tool result 的最大字符数。
   * 超过此阈值时，在 assemble 阶段进行 head+tail 算法截断并缓存。
   * 默认值：40000 字符（与 OpenClaw 核心的 DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS 一致）
   */
  toolResultTruncateChars: number;
  /** 每次异步 LLM 压缩最多处理的 turn 数量（按 token 数降序挑选） */
  maxCompactionsPerCycle: number;
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
  /** 可选 logger，用于调试 */
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  preserveRecentTurns: 5,
  maxContextTokens: 128_000,
  compactionThreshold: 0.75,
  systemPromptReserve: 10_000,
  toolResultMaxTokens: 500,
  toolResultTruncateChars: 40_000,
  maxCompactionsPerCycle: 3,
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
  private subtopicCacheLoaded = false;
  /** tool result 截断缓存（内存副本，底层持久化到磁盘） */
  private toolResultCacheMap = new Map<string, ToolResultCache>();
  /** 异步压缩任务键记录，避免重复触发 */
  private pendingCompactions = new Set<string>();
  /** topic compaction 缓存（内存副本） */
  private topicCompactionCacheMap = new Map<string, TopicCompactionCache>();
  /** 异步 topic compaction 任务标记 */
  private pendingTopicCompactions = new Set<string>();

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
        messages: allMessages.map((msg) => normalizeMessageContent(msg)),
        tokenCount: estimateMessagesTokens(allMessages),
      };
    }

    const tokenBudget =
      this.config.maxContextTokens - this.config.systemPromptReserve;
    const preserveCount = this.config.preserveRecentTurns;
    const recentCutoff = Math.max(0, turns.length - preserveCount);

    const result: EngineMessage[] = [];
    let usedTokens = 0;


    // 加载 tool result 缓存
    const toolResultCache = await this.getToolResultCache(sessionFile);
    let toolResultCacheDirty = false;

    // 加载 topic compaction 缓存
    const topicCompactionCache = await this.getTopicCompactionCache(sessionFile);

    // ── 话题相关性检测 ────────────────────────────────────────────
    const topics = query.getActiveTopics();
    const allTopics = query.getAllTopics ? query.getAllTopics() : topics;
    const currentTopicId = turns[turns.length - 1]?.topicId;

    // 子话题信息：从缓存读取（不在 assemble 中触发检测，检测在 turn 完成时异步发起）
    await this.loadSubTopicCacheIfNeeded(sessionFile);

    const currentSubtopicId = this.getCurrentSubtopicId(currentTopicId);

    // ══════════════════════════════════════════════════════════════════
    // Phase 0.5: Topic/SubTopic Compaction — 已有压缩的，直接用 summary
    //   跟踪哪些 topicId / turnId 已被 compaction 覆盖，Phase 1 中跳过其 turn
    // ══════════════════════════════════════════════════════════════════
    const topicCompactedIds = new Set<string>();
    /** subtopic compaction 覆盖的 turnId 集合 */
    const subtopicCompactedTurnIds = new Set<string>();

    for (const [cacheKey, entry] of Object.entries(topicCompactionCache.entries)) {
      // cacheKey 可能是：
      //   - 纯 topicId（整个 topic 压缩）
      //   - "topicId:subtopicId"（子话题压缩）
      const isSubtopicKey = cacheKey.includes(":");

      if (isSubtopicKey) {
        // 子话题压缩：输出 summary，并记录其覆盖的 turnIds
        result.push({
          role: "user",
          content: `[Sub-topic Summary: ${entry.topicLabel} (${entry.turnCount} turns)]: ${entry.summary}`,
        });
        usedTokens += entry.summaryTokens;
        for (const turnId of entry.turnIds) {
          subtopicCompactedTurnIds.add(turnId);
        }
        this.config.logger?.info(
          `[assemble] using subtopic compaction for "${entry.topicLabel}": ${entry.summaryTokens} tokens (was ${entry.originalTokens})`,
        );
      } else {
        // 整个 topic 压缩：只对非当前话题生效
        if (cacheKey !== currentTopicId) {
          result.push({
            role: "user",
            content: `[Topic Summary: ${entry.topicLabel} (${entry.turnCount} turns)]: ${entry.summary}`,
          });
          usedTokens += entry.summaryTokens;
          topicCompactedIds.add(cacheKey);
          this.config.logger?.info(
            `[assemble] using topic compaction for "${entry.topicLabel}": ${entry.summaryTokens} tokens (was ${entry.originalTokens})`,
          );
        }
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 1: 非保护区 turn
    //   - topic 已被 topic compaction 覆盖 → 跳过
    //   - 不相关的话题/子话题 → 直接丢弃（不进 prompt）
    //   - 相关 + 有 LLM 摘要 → 用摘要
    //   - 相关 + 无摘要 → 用原始消息（tool result 用 cache 截断版本）
    // ══════════════════════════════════════════════════════════════════
    let droppedTurns = 0;

    for (let i = 0; i < recentCutoff; i++) {
      const turn = turns[i];

      // 已被 topic compaction 或 subtopic compaction 覆盖的 turn → 跳过
      if (topicCompactedIds.has(turn.topicId)) {
        continue;
      }
      if (subtopicCompactedTurnIds.has(turn.id)) {
        continue;
      }

      // 话题相关性过滤：不相关的老旧 turn 直接丢弃
      if (this.config.topicAwareEnabled && allTopics.length > 1) {
        if (!this.isTurnRelevant(turn, currentTopicId, currentSubtopicId)) {
          droppedTurns++;
          continue;
        }
      }

      const turnState = this.state.turnStates[turn.id];

      if (turnState?.compacted && turnState.summary) {
        // 有 LLM 摘要：用摘要
        result.push({ role: "user", content: `[Summary of turn #${turn.sequence}]: ${turnState.summary}` });
        usedTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
      } else {
        // 无摘要：放入原始消息，tool result 用 cache 截断版本
        const rawLines = await query.readTurnRaw(turn.id);
        let msgIdx = 0;

        for (const line of rawLines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== "message") continue;
            const msg = obj.message;

            if (msg.role === "user") {
              const text = extractText(msg.content);
              result.push({ role: "user", content: text });
              usedTokens += estimateTokens(text);
            } else if (msg.role === "assistant") {
              const text = extractText(msg.content);
              if (text) {
                result.push({ role: "assistant", content: text });
                usedTokens += estimateTokens(text);
              }
            } else if (msg.role === "toolResult") {
              // tool result：优先用 cache 中的截断版本
              const cached = getCachedToolResult(toolResultCache, turn.id, msgIdx);
              const text = cached ? cached.truncatedContent : extractText(msg.content);
              result.push({ role: "tool", content: text, ...(msg.toolName ? { toolName: msg.toolName } : {}) });
              usedTokens += cached ? cached.truncatedTokens : estimateTokens(text);
            }
          } catch {
            // 解析失败，跳过
          }
          msgIdx++;
        }
      }
    }

    if (droppedTurns > 0) {
      this.config.logger?.info(
        `[assemble] dropped ${droppedTurns} irrelevant turns (different topic/subtopic)`,
      );
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 2: 保护区 Turn — 原文原样保留
    // ══════════════════════════════════════════════════════════════════
    if (recentCutoff < turns.length) {
      let recentMessageCount = 0;
      for (let i = recentCutoff; i < turns.length; i++) {
        recentMessageCount += turns[i].messageCount;
      }

      const recentMessages = allMessages.slice(-recentMessageCount);
      for (const msg of recentMessages) {
        result.push(msg);
        usedTokens += estimateMessageTokens(msg);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 3: 预压缩 — 每次 assemble 后检查是否超阈值
    //   超阈值 → 对非保护区大 tool result 做 head+tail 截断（0成本）
    //   仍超 → 异步触发 LLM 压缩
    //   截断/压缩结果下次 assemble 生效（KV cache 友好）
    // ══════════════════════════════════════════════════════════════════
    const thresholdTokens = tokenBudget * this.config.compactionThreshold;

    if (usedTokens > thresholdTokens) {
      this.config.logger?.info(
        `[pre-compact] total ${usedTokens} tokens exceeds threshold ${Math.round(thresholdTokens)}, running pre-compaction`,
      );

      const maxChars = this.config.toolResultTruncateChars;
      let tokensSaved = 0;

      // Step 1: 对非保护区 turn 中尚未截断的大 tool result 做 head+tail 截断
      for (let i = 0; i < recentCutoff; i++) {
        const turn = turns[i];
        // 已有 LLM 摘要的 turn 不需要截断（它在 prompt 中已经是摘要形式）
        const turnState = this.state.turnStates[turn.id];
        if (turnState?.compacted) continue;

        const rawLines = await query.readTurnRaw(turn.id);
        let msgIdx = 0;

        for (const line of rawLines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type !== "message") continue;
            const msg = obj.message;
            if (msg.role !== "toolResult") { msgIdx++; continue; }

            // 已缓存的跳过
            const cached = getCachedToolResult(toolResultCache, turn.id, msgIdx);
            if (cached) { msgIdx++; continue; }

            const text = extractText(msg.content);
            if (text.length <= maxChars) { msgIdx++; continue; }

            // 执行 head+tail 截断
            const truncated = truncateHeadTail(text, maxChars);
            const originalTokens = estimateTokens(text);
            const truncatedTokens = estimateTokens(truncated);

            setCachedToolResult(toolResultCache, turn.id, msgIdx, {
              truncatedContent: truncated,
              truncatedTokens,
              originalTokens,
              originalChars: text.length,
              truncatedAt: new Date().toISOString(),
            });
            toolResultCacheDirty = true;
            tokensSaved += originalTokens - truncatedTokens;

            this.config.logger?.info(
              `[pre-compact] truncated tool result turn #${turn.sequence} msgIdx=${msgIdx}: ${text.length} → ${truncated.length} chars, saved ~${originalTokens - truncatedTokens} tokens`,
            );
          } catch {
            // skip
          }
          msgIdx++;
        }

        // 截断已足够
        if (usedTokens - tokensSaved <= thresholdTokens) break;
      }

      // 持久化
      if (toolResultCacheDirty) {
        await saveToolResultCache(sessionFile, toolResultCache);
        this.config.logger?.info(
          `[pre-compact] tool result cache saved, ~${tokensSaved} tokens will be freed next assemble`,
        );
      }

      // Step 2: 截断后仍超阈值 → 异步触发 turn-level LLM 压缩
      if (usedTokens - tokensSaved > thresholdTokens) {
        this.triggerAsyncCompaction(sessionFile);
      }

      // Step 3: 兜底 — turn-level 压缩完成后仍超阈值 → 触发 topic-level 压缩
      // 场景：所有 turn 都属于同一个话题，turn 摘要累加仍超窗口
      // 策略：对最早的若干 topic（从时间最早的开始）生成 topic 级别的合并摘要
      const estimatedPostCompact = usedTokens - tokensSaved;
      if (estimatedPostCompact > thresholdTokens) {
        this.triggerAsyncTopicCompaction(sessionFile, turns, recentCutoff, topicCompactedIds);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 4: Normalize — 确保所有 message 的 content 为 array 格式
    //   OpenClaw Pi 运行时期望 content 为 ContentPart[] 而非 string
    // ══════════════════════════════════════════════════════════════════
    const normalized = result.map((msg) => normalizeMessageContent(msg));

    return {
      messages: normalized,
      tokenCount: usedTokens,
    };
  }

  // ── Tool Result Cache 管理 ─────────────────────────────────────────────

  /**
   * 获取或加载 tool result 缓存。
   * 缓存加载后保留在内存中，后续 assemble 直接使用。
   */
  private async getToolResultCache(sessionFile: string): Promise<ToolResultCache> {
    const cached = this.toolResultCacheMap.get(sessionFile);
    if (cached) return cached;

    const loaded = await loadToolResultCache(sessionFile);
    this.toolResultCacheMap.set(sessionFile, loaded);
    return loaded;
  }

  // ── 话题相关性判定 ─────────────────────────────────────────────

  /**
   * 获取当前子话题包含的 turn sequence 集合。
   * 如果没有子话题信息，返回 null（表示不做子话题级过滤）。
   */
  /**
   * 获取当前子话题 ID。
   */
  private getCurrentSubtopicId(currentTopicId: string | undefined): string | null {
    if (!currentTopicId) return null;
    const subtopicResult = this.subtopicCache.get(currentTopicId);
    if (!subtopicResult || subtopicResult.subtopics.length <= 1) return null;

    const currentSub = subtopicResult.subtopics.find(s => s.isCurrent);
    return currentSub?.id ?? null;
  }

  /**
   * 判断一个非保护区 turn 是否与当前上下文相关。
   *
   * 规则：
   *   1. 不同大话题 → 不相关（丢弃）
   *   2. 同大话题 + turn 有 subtopicId + 与当前 subtopicId 不同 → 不相关（丢弃）
   *   3. 同大话题 + turn 无 subtopicId → 相关（保留，还未分类）
   *   4. 同大话题 + 同 subtopicId → 相关（保留）
   */
  private isTurnRelevant(
    turn: TurnIndex,
    currentTopicId: string | undefined,
    currentSubtopicId: string | null,
  ): boolean {
    // 不同大话题 → 不相关
    if (turn.topicId !== currentTopicId) {
      return false;
    }

    // 同大话题，检查子话题
    if (currentSubtopicId && turn.subtopicId) {
      return turn.subtopicId === currentSubtopicId;
    }

    // turn 还未分类或无当前子话题信息 → 保留
    return true;
  }

  // ── 异步 LLM 压缩触发 ─────────────────────────────────────────────────

  /**
   * 异步触发早期 turn 的 LLM 摘要压缩。
   * 不阻塞当前 assemble，压缩完成后更新索引缓存，下次 assemble 生效。
   */
  private triggerAsyncCompaction(sessionFile: string): void {
    if (this.pendingCompactions.has(sessionFile)) return; // 已有进行中的压缩任务

    this.pendingCompactions.add(sessionFile);
    this.config.logger?.info(`[assemble] triggering async compaction for ${sessionFile}`);

    // 异步执行，不 await
    this.compact(sessionFile)
      .then((result) => {
        this.config.logger?.info(
          `[async-compact] completed: ${result.compactedCount} turns, ${result.tokensSaved} tokens saved, ${result.llmCalls} LLM calls`,
        );
      })
      .catch((err) => {
        this.config.logger?.error(
          `[async-compact] failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.pendingCompactions.delete(sessionFile);
      });
  }

  // ── Topic-Level 兜底压缩 ─────────────────────────────────────────

  /**
   * 异步触发 topic 级别的兜底压缩。
   *
   * 触发条件：经过 turn-level 压缩 + tool result 截断后，上下文仍超阈值。
   * 场景：
   *   - 所有 turn 属于同一话题，turn 摘要累加仍超窗口
   *   - 多话题但同话题内 turn 数量很大
   *
   * 策略：将同一 topic 下的多个 turn summaries 合并为一个 topic summary。
   * 优先压缩时间最早的 topic（距离当前上下文最远）。
   */
  private triggerAsyncTopicCompaction(
    sessionFile: string,
    turns: TurnIndex[],
    recentCutoff: number,
    alreadyCompactedTopicIds: Set<string>,
  ): void {
    if (this.pendingTopicCompactions.has(sessionFile)) return;

    this.pendingTopicCompactions.add(sessionFile);
    this.config.logger?.info(`[assemble] triggering async TOPIC compaction for ${sessionFile}`);

    this.compactTopics(sessionFile, turns, recentCutoff, alreadyCompactedTopicIds)
      .then((result) => {
        this.config.logger?.info(
          `[topic-compact] completed: ${result.compactedTopics} topics, ${result.tokensSaved} tokens saved, ${result.llmCalls} LLM calls`,
        );
      })
      .catch((err) => {
        this.config.logger?.error(
          `[topic-compact] failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.pendingTopicCompactions.delete(sessionFile);
      });
  }

  /**
   * Topic 级别压缩实现。
   *
   * 流程：
   *   1. 按 topicId 分组非保护区的 turn
   *   2. 从时间最早的 topic 开始，将该 topic 下所有 turn 的 summaries 合并
   *   3. 调用 LLM 生成一个 topic-level 概括摘要
   *   4. 结果存入 topic compaction cache
   *   5. 下次 assemble 时，该 topic 的所有 turn 被一条 topic summary 替代
   *
   * 与 turn-level compact 的关系：
   *   - turn-level: 单个 turn → 单个 summary
   *   - topic-level: 多个 turn summaries → 一个 topic summary
   *   - topic-level 是 turn-level 的“二次压缩”
   */
  async compactTopics(
    sessionFile: string,
    turns: TurnIndex[],
    recentCutoff: number,
    alreadyCompactedTopicIds: Set<string>,
  ): Promise<{
    compactedTopics: number;
    tokensSaved: number;
    llmCalls: number;
  }> {
    const { query } = await this.getIndex(sessionFile);
    const cache = await this.getTopicCompactionCache(sessionFile);
    const summaryCache = await loadSummaryCache(sessionFile);

    // 按 topicId 分组非保护区的 turn
    const topicGroups = new Map<string, { turns: TurnIndex[]; label: string }>();
    const currentTopicId = turns[turns.length - 1]?.topicId;

    for (let i = 0; i < recentCutoff; i++) {
      const turn = turns[i];
      const topicId = turn.topicId || "__default__";

      // 跳过已压缩的和当前话题
      if (alreadyCompactedTopicIds.has(topicId)) continue;
      if (topicId === currentTopicId) {
        // 当前话题也可以压缩（当它非常长时），但保留最近的部分
        // 这里先统计，后面决定是否压缩
      }

      const group = topicGroups.get(topicId);
      if (group) {
        group.turns.push(turn);
      } else {
        // 查找 topic label
        const allTopics = query.getAllTopics ? query.getAllTopics() : [];
        const topic = allTopics.find(t => t.id === topicId);
        topicGroups.set(topicId, {
          turns: [turn],
          label: topic?.label || topicId,
        });
      }
    }

    // 按时间排序：从最早的 topic 开始压缩
    const sortedTopics = [...topicGroups.entries()].sort((a, b) => {
      const aStart = a[1].turns[0]?.sequence ?? 0;
      const bStart = b[1].turns[0]?.sequence ?? 0;
      return aStart - bStart;
    });

    let compactedTopics = 0;
    let tokensSaved = 0;
    let llmCalls = 0;
    let cacheDirty = false;

    // 计算当前 token 预算 — 确定需要压缩几个 topic
    const tokenBudget = this.config.maxContextTokens - this.config.systemPromptReserve;
    const targetTokens = tokenBudget * this.config.compactionThreshold * 0.8; // 目标压到 80% 阈值

    let currentEstimatedTokens = 0;
    // 估算当前各 topic group 的 token 贡献
    for (const [, group] of sortedTopics) {
      for (const turn of group.turns) {
        const turnState = this.state.turnStates[turn.id];
        if (turnState?.compacted && turnState.summaryTokens) {
          currentEstimatedTokens += turnState.summaryTokens;
        } else {
          currentEstimatedTokens += turn.totalTokens;
        }
      }
    }

    for (const [topicId, group] of sortedTopics) {
      // 已经压到目标以下，停止
      if (currentEstimatedTokens <= targetTokens) break;

      // 已有 topic compaction 的跳过
      if (getTopicCompaction(cache, topicId)) continue;

      // 当前话题的特殊处理：
      // 如果所有 turn 都属于同一个 topic（即 currentTopicId），
      // 则降级到子话题级别压缩，而不是跳过。
      if (topicId === currentTopicId) {
        if (topicGroups.size > 1) {
          // 还有其他非当前 topic 可压缩，优先压缩它们
          continue;
        }
        // 唯一的 topic 就是当前话题 → 子话题级压缩
        const subtopicResult = await this.compactSubTopics(
          sessionFile, topicId, group.turns, group.label, summaryCache, cache,
        );
        compactedTopics += subtopicResult.compactedSubTopics;
        tokensSaved += subtopicResult.tokensSaved;
        llmCalls += subtopicResult.llmCalls;
        currentEstimatedTokens -= subtopicResult.tokensSaved;
        if (subtopicResult.compactedSubTopics > 0) cacheDirty = true;
        continue;
      }

      // Turn 数太少不值得做 topic 级压缩
      if (group.turns.length < 2) continue;

      // 收集该 topic 下所有 turn 的摘要/内容
      const turnSummaries: string[] = [];
      let topicOriginalTokens = 0;

      for (const turn of group.turns) {
        const turnState = this.state.turnStates[turn.id];
        if (turnState?.compacted && turnState.summary) {
          turnSummaries.push(`Turn #${turn.sequence}: ${turnState.summary}`);
          topicOriginalTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
        } else {
          // 没有 turn summary，用 preview
          const cached = getCachedSummary(summaryCache, turn.id);
          if (cached) {
            turnSummaries.push(`Turn #${turn.sequence}: ${cached.summary}`);
            topicOriginalTokens += cached.tokens;
          } else {
            turnSummaries.push(
              `Turn #${turn.sequence}: User: ${turn.userPreview.slice(0, 100)} → Assistant: ${turn.assistantPreview.slice(0, 100)}`,
            );
            topicOriginalTokens += turn.totalTokens;
          }
        }
      }

      // 调用 LLM 生成 topic-level 摘要
      const topicContent = turnSummaries.join("\n\n");
      let topicSummary: string;
      let method: "llm" | "local" = "local";

      if (this.config.summarize) {
        try {
          this.config.logger?.info(
            `[topic-compact] topic "${group.label}" (${group.turns.length} turns, ~${topicOriginalTokens} tokens): calling LLM`,
          );
          topicSummary = await this.config.summarize(
            topicContent,
            `Generate a concise topic-level summary for topic "${group.label}" containing ${group.turns.length} turns. ` +
            `Capture key decisions, actions taken, and results. Be concise but preserve important details like file paths, error messages, and conclusions.`,
          );
          method = "llm";
          llmCalls++;
          this.config.logger?.info(
            `[topic-compact] topic "${group.label}": LLM summary OK (${topicSummary.length} chars)`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.config.logger?.error(
            `[topic-compact] topic "${group.label}": LLM failed: ${errMsg}, using local fallback`,
          );
          topicSummary = buildLocalTopicSummary(group.label, group.turns, this.state);
        }
      } else {
        topicSummary = buildLocalTopicSummary(group.label, group.turns, this.state);
      }

      const summaryTokens = estimateTokens(topicSummary);

      // 写入缓存
      const entry: TopicCompactionEntry = {
        topicId,
        topicLabel: group.label,
        summary: topicSummary,
        summaryTokens,
        turnCount: group.turns.length,
        turnIds: group.turns.map(t => t.id),
        originalTokens: topicOriginalTokens,
        method,
        createdAt: new Date().toISOString(),
      };
      setTopicCompaction(cache, entry);
      cacheDirty = true;

      // 更新估算
      currentEstimatedTokens -= topicOriginalTokens;
      currentEstimatedTokens += summaryTokens;
      tokensSaved += topicOriginalTokens - summaryTokens;
      compactedTopics++;

      this.config.logger?.info(
        `[topic-compact] topic "${group.label}": ${topicOriginalTokens} → ${summaryTokens} tokens (saved ${topicOriginalTokens - summaryTokens})`,
      );
    }

    // 持久化
    if (cacheDirty) {
      await saveTopicCompactionCache(sessionFile, cache);
      // 更新内存缓存
      this.topicCompactionCacheMap.set(sessionFile, cache);
    }

    return { compactedTopics, tokensSaved, llmCalls };
  }

  // ── 子话题级压缩（同一大话题内的兜底）─────────────────────

  /**
   * 子话题级压缩：当所有 turn 都属于同一个大 topic 时的兜底策略。
   *
   * 场景：用户一直围绕同一个主题工作（如“插件开发”），但主题内有多个子任务：
   *   - 子话题 1：“配置注册” (turns 0-5)
   *   - 子话题 2：“调试 502 错误” (turns 6-8)
   *   - 子话题 3：“开发 topic 分割” (turns 9-15) ← 当前
   *
   * 压缩策略：
   *   - 当前子话题不压缩（保留细粒度）
   *   - 从最早的子话题开始，将其下的多个 turn 合并为一个 subtopic summary
   *   - 结果存入 topic compaction cache，以 "topicId:subtopicId" 为 key
   */
  private async compactSubTopics(
    sessionFile: string,
    topicId: string,
    topicTurns: TurnIndex[],
    topicLabel: string,
    summaryCache: SummaryCache,
    topicCache: TopicCompactionCache,
  ): Promise<{
    compactedSubTopics: number;
    tokensSaved: number;
    llmCalls: number;
  }> {
    // 加载子话题信息
    await this.loadSubTopicCacheIfNeeded(sessionFile);
    const subtopicResult = this.subtopicCache.get(topicId);

    // 如果没有子话题信息，尝试用启发式检测生成
    let subtopics: Array<{ id: string; label: string; turnSequences: number[]; isCurrent: boolean }>;
    if (!subtopicResult || subtopicResult.subtopics.length <= 1) {
      // 没有子话题分割信息，用启发式检测临时生成
      const { detectSubTopicsByHeuristic } = await import("../topic/subtopic-detector.js");
      const detected = detectSubTopicsByHeuristic(topicId, topicTurns);
      subtopics = detected.subtopics;

      if (subtopics.length <= 1) {
        // 真的只有一个子话题，用时间切分法做最后兜底
        this.config.logger?.info(
          `[subtopic-compact] topic "${topicLabel}": only 1 subtopic detected, falling back to time-based chunking`,
        );
        subtopics = this.chunkTurnsByTime(topicTurns);
      }
    } else {
      subtopics = subtopicResult.subtopics;
    }

    this.config.logger?.info(
      `[subtopic-compact] topic "${topicLabel}": ${subtopics.length} subtopics, compacting from earliest`,
    );

    // 按时间排序（最早的子话题优先压缩）
    const sortedSubtopics = [...subtopics].sort((a, b) => {
      const aMin = Math.min(...a.turnSequences);
      const bMin = Math.min(...b.turnSequences);
      return aMin - bMin;
    });

    // 找到当前子话题（不压缩）
    const currentSubtopic = sortedSubtopics.find(s => s.isCurrent);
    const currentSubtopicId = currentSubtopic?.id;

    const tokenBudget = this.config.maxContextTokens - this.config.systemPromptReserve;
    const targetTokens = tokenBudget * this.config.compactionThreshold * 0.8;

    let compactedSubTopics = 0;
    let tokensSaved = 0;
    let llmCalls = 0;

    // turn sequence → TurnIndex 的映射
    const turnBySequence = new Map<number, TurnIndex>();
    for (const turn of topicTurns) {
      turnBySequence.set(turn.sequence, turn);
    }

    // 估算当前总 token
    let currentEstimatedTokens = 0;
    for (const turn of topicTurns) {
      const turnState = this.state.turnStates[turn.id];
      if (turnState?.compacted && turnState.summaryTokens) {
        currentEstimatedTokens += turnState.summaryTokens;
      } else {
        currentEstimatedTokens += turn.totalTokens;
      }
    }

    for (const subtopic of sortedSubtopics) {
      // 已压到目标以下，停止
      if (currentEstimatedTokens <= targetTokens) break;

      // 当前子话题不压缩
      if (subtopic.id === currentSubtopicId) continue;

      // 检查是否已压缩
      const cacheKey = `${topicId}:${subtopic.id}`;
      if (getTopicCompaction(topicCache, cacheKey)) continue;

      // 收集该子话题下的 turn
      const subTurns = subtopic.turnSequences
        .map(seq => turnBySequence.get(seq))
        .filter((t): t is TurnIndex => t !== undefined);

      if (subTurns.length < 2) continue;

      // 收集 turn summaries
      const turnSummaries: string[] = [];
      let subtopicOriginalTokens = 0;

      for (const turn of subTurns) {
        const turnState = this.state.turnStates[turn.id];
        if (turnState?.compacted && turnState.summary) {
          turnSummaries.push(`Turn #${turn.sequence}: ${turnState.summary}`);
          subtopicOriginalTokens += turnState.summaryTokens ?? estimateTokens(turnState.summary);
        } else {
          const cached = getCachedSummary(summaryCache, turn.id);
          if (cached) {
            turnSummaries.push(`Turn #${turn.sequence}: ${cached.summary}`);
            subtopicOriginalTokens += cached.tokens;
          } else {
            turnSummaries.push(
              `Turn #${turn.sequence}: User: ${turn.userPreview.slice(0, 100)} → Assistant: ${turn.assistantPreview.slice(0, 100)}`,
            );
            subtopicOriginalTokens += turn.totalTokens;
          }
        }
      }

      // 调用 LLM 生成 subtopic-level 摘要
      const content = turnSummaries.join("\n\n");
      let summary: string;
      let method: "llm" | "local" = "local";

      if (this.config.summarize) {
        try {
          this.config.logger?.info(
            `[subtopic-compact] subtopic "${subtopic.label}" (${subTurns.length} turns, ~${subtopicOriginalTokens} tokens): calling LLM`,
          );
          summary = await this.config.summarize(
            content,
            `Generate a concise summary for sub-topic "${subtopic.label}" within topic "${topicLabel}". ` +
            `This sub-topic contains ${subTurns.length} turns. ` +
            `Capture the key problem, actions taken, and resolution. Preserve file paths, commands, and error messages.`,
          );
          method = "llm";
          llmCalls++;
          this.config.logger?.info(
            `[subtopic-compact] subtopic "${subtopic.label}": LLM summary OK (${summary.length} chars)`,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.config.logger?.error(
            `[subtopic-compact] subtopic "${subtopic.label}": LLM failed: ${errMsg}`,
          );
          summary = buildLocalTopicSummary(subtopic.label, subTurns, this.state);
        }
      } else {
        summary = buildLocalTopicSummary(subtopic.label, subTurns, this.state);
      }

      const summaryTokens = estimateTokens(summary);

      // 存入缓存，用 "topicId:subtopicId" 作为 key
      const entry: TopicCompactionEntry = {
        topicId: cacheKey,
        topicLabel: `${topicLabel} > ${subtopic.label}`,
        summary,
        summaryTokens,
        turnCount: subTurns.length,
        turnIds: subTurns.map(t => t.id),
        originalTokens: subtopicOriginalTokens,
        method,
        createdAt: new Date().toISOString(),
      };
      setTopicCompaction(topicCache, entry);

      currentEstimatedTokens -= subtopicOriginalTokens;
      currentEstimatedTokens += summaryTokens;
      tokensSaved += subtopicOriginalTokens - summaryTokens;
      compactedSubTopics++;

      this.config.logger?.info(
        `[subtopic-compact] "${subtopic.label}": ${subtopicOriginalTokens} → ${summaryTokens} tokens (saved ${subtopicOriginalTokens - summaryTokens})`,
      );
    }

    // 持久化由调用方处理（compactTopics 中 cacheDirty=true 后 save）
    if (compactedSubTopics > 0) {
      await saveTopicCompactionCache(sessionFile, topicCache);
      this.topicCompactionCacheMap.set(sessionFile, topicCache);
    }

    return { compactedSubTopics, tokensSaved, llmCalls };
  }

  /**
   * 当启发式检测也无法分割子话题时，用固定 chunk 大小切分。
   * 每 5 个 turn 为一组，最后一组标记为 isCurrent。
   */
  private chunkTurnsByTime(
    turns: TurnIndex[],
  ): Array<{ id: string; label: string; turnSequences: number[]; isCurrent: boolean }> {
    const CHUNK_SIZE = 5;
    const chunks: Array<{ id: string; label: string; turnSequences: number[]; isCurrent: boolean }> = [];

    for (let i = 0; i < turns.length; i += CHUNK_SIZE) {
      const chunk = turns.slice(i, i + CHUNK_SIZE);
      const isLast = i + CHUNK_SIZE >= turns.length;
      chunks.push({
        id: `chunk-${Math.floor(i / CHUNK_SIZE)}`,
        label: `Turns ${chunk[0].sequence}-${chunk[chunk.length - 1].sequence}`,
        turnSequences: chunk.map(t => t.sequence),
        isCurrent: isLast,
      });
    }

    return chunks;
  }

  // ── Topic Compaction Cache 管理 ───────────────────────────────────

  private async getTopicCompactionCache(sessionFile: string): Promise<TopicCompactionCache> {
    const cached = this.topicCompactionCacheMap.get(sessionFile);
    if (cached) return cached;

    const loaded = await loadTopicCompactionCache(sessionFile);
    this.topicCompactionCacheMap.set(sessionFile, loaded);
    return loaded;
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

    // 先处理已缓存的 turn（恢复内存状态，不调 LLM）
    const uncachedTurns: TurnIndex[] = [];

    for (let i = 0; i < compactCutoff; i++) {
      const turn = turns[i];

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
      } else {
        uncachedTurns.push(turn);
      }
    }

    // 按 totalTokens 降序排列，挑选 top-N 最大的 turn 进行 LLM 压缩
    const maxPerCycle = this.config.maxCompactionsPerCycle;
    const toCompact = uncachedTurns
      .slice() // 不破坏原数组
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, maxPerCycle);

    if (toCompact.length > 0) {
      this.config.logger?.info(
        `[compact] selecting top ${toCompact.length} largest turns (of ${uncachedTurns.length} uncached): ${toCompact.map(t => `#${t.sequence}(${t.totalTokens}tok)`).join(", ")}`,
      );
    }

    for (const turn of toCompact) {
      const rawLines = await query.readTurnRaw(turn.id);

      // 加载 tool result cache，让 buildCompactInput 使用截断后的 tool result
      const trCache = await this.getToolResultCache(sessionFile);

      // 构建给 LLM 的输入：使用截断后的 tool result，降低输入 token 数
      const turnContent = buildCompactInput(turn, rawLines, trCache);

      let summary: string;
      let method: "local" | "llm" = "local";

      if (this.config.summarize) {
        try {
          this.config.logger?.info(`[compact] turn #${turn.sequence} (${turn.totalTokens} tokens): calling LLM for summary`);
          summary = await this.config.summarize(
            turnContent,
            `Turn #${turn.sequence}: user asked "${turn.userPreview.slice(0, 100)}"`,
          );
          method = "llm";
          llmCalls++;
          this.config.logger?.info(`[compact] turn #${turn.sequence}: LLM summary OK (${summary.length} chars)`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.config.logger?.error(`[compact] turn #${turn.sequence}: LLM summary failed: ${errMsg}`);
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

    return { compactedCount, tokensSaved, llmCalls, cacheHits };
  }

  /**
   * 从磁盘加载子话题缓存到内存（仅读取，不触发检测）。
   * assemble 时调用，确保过滤时有子话题数据可用。
   */
  private async loadSubTopicCacheIfNeeded(sessionFile: string): Promise<void> {
    if (this.subtopicCacheLoaded) return;
    const diskCache = await loadSubTopicCache(sessionFile);
    for (const [topicId, result] of Object.entries(diskCache.entries)) {
      this.subtopicCache.set(topicId, result as SubTopicResult);
    }
    this.subtopicCacheLoaded = true;
  }

  // ── Turn 完成回调：异步轻量话题抽取 ─────────────────────────

  /**
   * 当一轮 turn 完整结束时（收到最终 assistant 回复后）调用。
   * 异步发起轻量 LLM 话题抽取，不阻塞当前流程。
   *
   * 输入精简：只用 userPreview + assistantPreview + toolsUsed，
   * 不传大段 tool result 或完整模型回复。
   */
  onTurnComplete(sessionFile: string, turn: TurnIndex): void {
    if (!this.config.topicAwareEnabled) return;
    if (!this.config.summarize) return; // 没有 LLM 函数则跳过

    // 异步执行，不阻塞
    this.classifyTurnTopic(sessionFile, turn).catch((err) => {
      this.config.logger?.error(
        `[topic-classify] turn #${turn.sequence} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * 轻量 LLM 话题分类：对单个 turn 抽取话题标签并判断是否属于当前子话题。
   *
   * 输入约 100-200 tokens，输出约 30-50 tokens。
   */
  private async classifyTurnTopic(sessionFile: string, turn: TurnIndex): Promise<void> {
    const { query } = await this.getIndex(sessionFile);
    const allTopics = query.getAllTopics();

    // 构建精简输入：只用 preview + 工具名
    const input = buildTopicClassifyInput(turn, allTopics);

    try {
      const llmOutput = await this.config.summarize!(
        input,
        "Classify this turn's sub-topic. Reply JSON: {\"subtopic\": \"<short label>\", \"isNewSubtopic\": bool}",
      );

      const classification = parseTopicClassifyResult(llmOutput);
      if (!classification) return;

      // 更新子话题缓存
      await this.updateSubTopicCache(
        sessionFile,
        turn,
        classification.subtopic,
        classification.isNewSubtopic,
      );
    } catch (err) {
      this.config.logger?.error(
        `[topic-classify] LLM call failed for turn #${turn.sequence}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 更新子话题缓存：将 turn 归入现有子话题或创建新子话题。
   */
  private async updateSubTopicCache(
    sessionFile: string,
    turn: TurnIndex,
    subtopicLabel: string,
    isNew: boolean,
  ): Promise<void> {
    const topicId = turn.topicId;
    if (!topicId) return;

    const diskCache = await loadSubTopicCache(sessionFile);
    let result = diskCache.entries[topicId] ?? {
      topicId,
      subtopics: [],
      method: "llm" as const,
      createdAt: new Date().toISOString(),
    };

    if (isNew || result.subtopics.length === 0) {
      // 新子话题：把之前的标记为非当前
      result.subtopics = result.subtopics.map(s => ({ ...s, isCurrent: false }));
      result.subtopics.push({
        id: `${topicId}-sub-${result.subtopics.length}`,
        label: subtopicLabel,
        turnSequences: [turn.sequence],
        isCurrent: true,
      });
    } else {
      // 归入当前子话题
      const current = result.subtopics.find(s => s.isCurrent);
      if (current) {
        if (!current.turnSequences.includes(turn.sequence)) {
          current.turnSequences.push(turn.sequence);
        }
      } else {
        // 没有当前子话题，归入最后一个
        const last = result.subtopics[result.subtopics.length - 1];
        if (last && !last.turnSequences.includes(turn.sequence)) {
          last.turnSequences.push(turn.sequence);
          last.isCurrent = true;
        }
      }
    }

    diskCache.entries[topicId] = result;
    await saveSubTopicCache(sessionFile, diskCache);

    // 回填 turn 索引中的 subtopicId/subtopicLabel
    const currentSub = result.subtopics.find(s => s.isCurrent);
    if (currentSub) {
      turn.subtopicId = currentSub.id;
      turn.subtopicLabel = currentSub.label;
      // 持久化索引更新（异步保存，不阻塞）
      this.persistIndexUpdate(sessionFile).catch(() => {});
    }

    // 同步到内存
    this.subtopicCache.set(topicId, result);
    this.config.logger?.info(
      `[topic-classify] turn #${turn.sequence} → subtopic "${subtopicLabel}" (${isNew ? "new" : "existing"})`,
    );
  }

  /**
   * 异步保存索引更新到磁盘（subtopicId 回填后）。
   */
  private async persistIndexUpdate(sessionFile: string): Promise<void> {
    const cached = this.indexCache.get(sessionFile);
    if (cached) {
      await saveIndex(sessionFile, cached.index);
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
 * 对单条消息做智能裁剪（保留作为工具函数导出）：
 *   - user / assistant 消息：不截断（这是对话的核心意图和结果）
 *   - tool result：截断到 maxTokens
 *     因为 tool 输出通常是大段文件内容、命令输出、错误堆栈，
 *     头尾部分足够理解上下文，中间可以省略。
 */
export function trimMessageForContext(
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
      content: truncateHeadTailByTokens(msg.content, maxTokens),
    };
  }

  if (Array.isArray(msg.content)) {
    const trimmed = msg.content.map((part) => {
      if (typeof part.text === "string" && estimateTokens(part.text) > maxTokens) {
        return { ...part, text: truncateHeadTailByTokens(part.text, maxTokens) };
      }
      return part;
    });
    return { ...msg, content: trimmed };
  }

  return msg;
}

/**
 * 头尾截断（token-based）：保留前 60% 和后 30% 的 token，中间用省略标记。
 * 用于保护区内的 trimMessageForContext。
 * 这样上下文两头都能看到，中间重复部分被省略。
 */
function truncateHeadTailByTokens(text: string, maxTokens: number): string {
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
 * Topic 级别的本地摘要（LLM 不可用时的回退方案）。
 * 将多个 turn 的信息合并为一个精炼的 topic 概述。
 */
function buildLocalTopicSummary(
  topicLabel: string,
  groupTurns: TurnIndex[],
  state: EngineState,
): string {
  const parts: string[] = [];

  parts.push(`## Topic: ${topicLabel} (${groupTurns.length} turns)`);
  parts.push(``);

  // 收集工具和要点
  const allTools = new Set<string>();
  const highlights: string[] = [];

  for (const turn of groupTurns) {
    for (const tool of turn.toolsUsed) allTools.add(tool);

    const turnState = state.turnStates[turn.id];
    if (turnState?.compacted && turnState.summary) {
      // 取摘要的前 2 行
      const lines = turnState.summary.split("\n").filter(l => l.trim());
      highlights.push(lines.slice(0, 2).join("; "));
    } else {
      highlights.push(`User: ${turn.userPreview.slice(0, 80)} → ${turn.assistantPreview.slice(0, 60)}`);
    }
  }

  if (allTools.size > 0) {
    parts.push(`Tools used: ${[...allTools].join(", ")}`);
  }

  parts.push(``);
  parts.push(`Key turns:`);
  // 最多保留 8 个要点，避免本地摘要太长
  for (const h of highlights.slice(0, 8)) {
    parts.push(`  - ${h}`);
  }
  if (highlights.length > 8) {
    parts.push(`  - ... and ${highlights.length - 8} more turns`);
  }

  return parts.join("\n");
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
function buildCompactInput(turn: TurnIndex, rawLines: string[], toolResultCache?: ToolResultCache): string {
  const parts: string[] = [];

  parts.push(`[Turn #${turn.sequence} | ${turn.messageCount} messages | ${turn.toolsUsed.length} tools]`);
  parts.push(``);

  let msgIdx = 0;
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
        // tool result：优先用 cache 中的截断版本，否则用原始全文
        const cached = toolResultCache ? getCachedToolResult(toolResultCache, turn.id, msgIdx) : null;
        const text = cached ? cached.truncatedContent : extractText(msg.content);
        const err = msg.isError ? " ❌ ERROR" : "";
        parts.push(`[Tool ${msg.toolName || "?"}${err}]: ${text}`);
      }
    } catch {
      // 解析失败，跳过
    }
    msgIdx++;
  }

  return parts.join("\n");
}

/**
 * Normalize message content to array format.
 * OpenClaw Pi runtime expects content to be ContentPart[] (array), not string.
 * This ensures all messages returned from assemble have array-format content.
 */
function normalizeMessageContent(msg: EngineMessage): EngineMessage {
  if (typeof msg.content === "string") {
    return { ...msg, content: [{ type: "text", text: msg.content }] };
  }
  if (!msg.content || !Array.isArray(msg.content)) {
    return { ...msg, content: [{ type: "text", text: String(msg.content ?? "") }] };
  }
  // Ensure each element in the array is a valid object (not raw string)
  const normalized = (msg.content as unknown[]).map((part) => {
    if (typeof part === "string") {
      return { type: "text" as const, text: part };
    }
    if (!part || typeof part !== "object") {
      return { type: "text" as const, text: String(part ?? "") };
    }
    return part as { type: string; text?: string; [key: string]: unknown };
  });
  return { ...msg, content: normalized };
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

// ═════════════════════════════════════════════════════════════════════════
//  轻量话题分类 — 辅助函数
// ═════════════════════════════════════════════════════════════════════════

/**
 * 构建轻量话题分类的 LLM 输入。
 * 只用 preview + 工具名，约 100-200 tokens。
 */
function buildTopicClassifyInput(turn: TurnIndex, allTopics: TopicIndex[]): string {
  const parts: string[] = [];

  // 当前话题列表（给 LLM 上下文）
  if (allTopics.length > 0) {
    const topicLabels = allTopics.map(t => t.label).filter(Boolean);
    if (topicLabels.length > 0) {
      parts.push(`Existing topics: ${topicLabels.join(", ")}`);
    }
  }

  // Turn 摘要信息
  parts.push(`Turn #${turn.sequence}:`);
  parts.push(`  User: ${turn.userPreview.slice(0, 150)}`);
  parts.push(`  Assistant: ${turn.assistantPreview.slice(0, 150)}`);
  if (turn.toolsUsed.length > 0) {
    parts.push(`  Tools: ${turn.toolsUsed.join(", ")}`);
  }

  return parts.join("\n");
}

/**
 * 解析 LLM 话题分类结果。
 * 期望格式：{"subtopic": "<label>", "isNewSubtopic": bool}
 */
function parseTopicClassifyResult(
  llmOutput: string,
): { subtopic: string; isNewSubtopic: boolean } | null {
  try {
    // 尝试直接解析
    const parsed = JSON.parse(llmOutput);
    if (parsed.subtopic && typeof parsed.isNewSubtopic === "boolean") {
      return { subtopic: parsed.subtopic, isNewSubtopic: parsed.isNewSubtopic };
    }
  } catch {
    // 尝试提取 JSON 块
    const match = llmOutput.match(/\{[^}]*"subtopic"[^}]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed.subtopic && typeof parsed.isNewSubtopic === "boolean") {
          return { subtopic: parsed.subtopic, isNewSubtopic: parsed.isNewSubtopic };
        }
      } catch {
        // fall through
      }
    }
  }
  return null;
}

