/**
 * Session Index Builder
 *
 * 核心逻辑：遍历解析后的行数据，将 message 行组装为 Turn。
 *
 * Turn 边界规则：
 *   遇到 role=user 的 message → 开启新 Turn
 *   后续的 assistant / toolResult 消息都属于当前 Turn
 *   直到遇到下一个 user 消息
 *
 * 每个 Turn 记录：
 *   - 行号范围 [lineStart, lineEnd]（1-based, inclusive）
 *   - token 估算、工具使用、预览文本等摘要信息
 */

import { stat } from "node:fs/promises";
import type {
  SessionIndex,
  SessionMeta,
  TurnIndex,
  TopicIndex,
  IndexStats,
} from "./types.js";
import { parseSessionFile, type ParsedLine } from "./parser.js";
import { TopicSegmenter } from "../topic/topic-segmenter.js";
import type { TopicSegmenterConfig, TopicSegment } from "../topic/types.js";

/**
 * 从 session JSONL 文件构建索引。
 * 支持增量：传入 existingIndex 时只解析新行。
 *
 * @param sessionFilePath session JSONL 文件路径
 * @param existingIndex 现有索引（增量更新时传入）
 * @param segmenterConfig TopicSegmenter 配置（控制话题检测行为）
 */
export async function buildSessionIndex(
  sessionFilePath: string,
  existingIndex?: SessionIndex,
  segmenterConfig?: Partial<TopicSegmenterConfig>,
): Promise<SessionIndex> {
  const startLine = existingIndex ? existingIndex.indexedLineCount + 1 : 1;
  const parsed = await parseSessionFile(sessionFilePath, startLine);
  const fileStat = await stat(sessionFilePath);
  const modifiedAt = fileStat.mtime.toISOString();

  if (existingIndex && parsed.length === 0) {
    return existingIndex;
  }

  if (existingIndex && startLine > 1) {
    return mergeIncremental(existingIndex, parsed, modifiedAt, segmenterConfig);
  }

  return buildFull(parsed, sessionFilePath, modifiedAt, segmenterConfig);
}

// ═══════════════════════════════════════════════════════════════════════════
//  全量构建
// ═══════════════════════════════════════════════════════════════════════════

async function buildFull(
  parsed: ParsedLine[],
  sessionFilePath: string,
  modifiedAt: string,
  segmenterConfig?: Partial<TopicSegmenterConfig>,
): Promise<SessionIndex> {
  // 提取 meta
  const meta = extractMeta(parsed, sessionFilePath);

  // 组装 Turns
  const turns = buildTurns(parsed);

  // 使用 TopicSegmenter 做话题分段（仅 embedding 层，不调 LLM）
  const topics = await buildTopicsFromSegments(turns, segmenterConfig);

  // 回填 topicId
  backfillTopicIds(turns, topics);

  // lookup & stats
  const turnById = buildTurnLookup(turns);
  const stats = buildStats(turns, topics, parsed);

  const lastLine = parsed.length > 0 ? parsed[parsed.length - 1].line : 0;

  return {
    version: 1,
    meta,
    turns,
    topics,
    turnById,
    stats,
    builtAt: new Date().toISOString(),
    sessionFileModifiedAt: modifiedAt,
    indexedLineCount: lastLine,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Turn 组装
// ═══════════════════════════════════════════════════════════════════════════

interface PendingTurn {
  /** user 消息的 entryId，作为 Turn ID */
  userEntryId: string;
  lineStart: number;
  lineEnd: number;
  messageCount: number;
  totalTokens: number;
  /** 各角色 token 细分 */
  userTokens: number;
  assistantTokens: number;
  toolResultTokens: number;
  toolsUsed: Set<string>;
  toolCallCount: number;
  hasError: boolean;
  userPreview: string;
  assistantPreview: string;
  hasAssistantText: boolean;
  startTime: string;
  endTime: string;
}

function buildTurns(parsed: ParsedLine[]): TurnIndex[] {
  const turns: TurnIndex[] = [];
  let pending: PendingTurn | null = null;

  function finalize(p: PendingTurn | null): TurnIndex | null {
    if (!p || p.messageCount === 0) return null;
    return {
      id: p.userEntryId,
      sequence: turns.length,
      lineStart: p.lineStart,
      lineEnd: p.lineEnd,
      messageCount: p.messageCount,
      toolsUsed: [...p.toolsUsed],
      toolCallCount: p.toolCallCount,
      totalTokens: p.totalTokens,
      tokenBreakdown: {
        user: p.userTokens,
        assistant: p.assistantTokens,
        toolResult: p.toolResultTokens,
      },
      userPreview: p.userPreview,
      assistantPreview: p.assistantPreview,
      startTime: p.startTime,
      endTime: p.endTime,
      topicId: "",
      hasError: p.hasError,
      importance: computeTurnImportance(p),
    };
  }

  for (const line of parsed) {
    if (line.type !== "message" || !line.role) continue;

    if (line.role === "user") {
      // 关闭上一个 Turn
      const prev = finalize(pending);
      if (prev) turns.push(prev);

      // 开启新 Turn
      pending = {
        userEntryId: line.entryId,
        lineStart: line.line,
        lineEnd: line.line,
        messageCount: 1,
        totalTokens: line.tokenEstimate ?? 0,
        userTokens: line.tokenEstimate ?? 0,
        assistantTokens: 0,
        toolResultTokens: 0,
        toolsUsed: new Set(),
        toolCallCount: 0,
        hasError: false,
        userPreview: line.userText ?? "",
        assistantPreview: "",
        hasAssistantText: false,
        startTime: line.timestamp,
        endTime: line.timestamp,
      };
    } else if (pending) {
      // assistant / toolResult 归入当前 Turn
      pending.lineEnd = line.line;
      pending.messageCount++;
      pending.totalTokens += line.tokenEstimate ?? 0;
      pending.endTime = line.timestamp;

      if (line.role === "assistant") {
        pending.assistantTokens += line.tokenEstimate ?? 0;
        // 取最后一次有文本的 assistant 回复作为预览
        if (line.assistantText) {
          pending.assistantPreview = line.assistantText;
          pending.hasAssistantText = true;
        }
        // 统计 toolCall
        if (line.toolCalls) {
          pending.toolCallCount += line.toolCalls.length;
          for (const name of line.toolCalls) {
            pending.toolsUsed.add(name);
          }
        }
      } else if (line.role === "toolResult") {
        pending.toolResultTokens += line.tokenEstimate ?? 0;
        if (line.toolName) pending.toolsUsed.add(line.toolName);
        if (line.isError) pending.hasError = true;
      }
    }
  }

  // 关闭最后一个 Turn
  const last = finalize(pending);
  if (last) turns.push(last);

  return turns;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Meta / Topic / Lookup / Stats
// ═══════════════════════════════════════════════════════════════════════════

function extractMeta(parsed: ParsedLine[], sessionFilePath: string): SessionMeta {
  const meta: SessionMeta = {
    sessionId: "",
    sessionFile: sessionFilePath,
    sessionVersion: 0,
    cwd: "",
    createdAt: "",
    currentModel: { provider: "", modelId: "" },
  };
  for (const line of parsed) {
    if (line.type === "session") {
      meta.sessionId = line.sessionId ?? "";
      meta.sessionVersion = line.sessionVersion ?? 0;
      meta.cwd = line.cwd ?? "";
      meta.createdAt = line.timestamp;
    }
    if (line.type === "model_change") {
      meta.currentModel = {
        provider: line.provider ?? "",
        modelId: line.modelId ?? "",
      };
    }
  }
  return meta;
}

function buildDefaultTopic(turns: TurnIndex[]): TopicIndex[] {
  if (turns.length === 0) return [];
  return [
    {
      id: `topic-${turns[0].id}`,
      label: "default",
      turnIds: turns.map((t) => t.id),
      status: "active",
      totalTokens: turns.reduce((sum, t) => sum + t.totalTokens, 0),
      startTime: turns[0].startTime,
      endTime: turns[turns.length - 1].endTime,
    },
  ];
}

/**
 * 使用 TopicSegmenter 对全量 Turn 做话题分段，返回 TopicIndex 列表。
 *
 * 注意： builder 中只用 embedding 层，不调 LLM。
 * LLM 确认放在 compact 阶段。
 *
 * @param turns 全量 Turn 列表
 * @param segmenterConfig 话题分段器配置（可选）
 * @returns TopicIndex 列表
 */
async function buildTopicsFromSegments(
  turns: TurnIndex[],
  segmenterConfig?: Partial<TopicSegmenterConfig>,
): Promise<TopicIndex[]> {
  if (turns.length === 0) return [];

  try {
    // 全量构建：不调 LLM
    const segmenter = new TopicSegmenter({
      ...segmenterConfig,
      enableLlmConfirmation: false, // builder 中不调 LLM
      llmClassify: undefined,
    });

    const segments = await segmenter.segment(turns);

    if (segments.length === 0) {
      return buildDefaultTopic(turns);
    }

    return segments.map((seg) => ({
      id: seg.topicId,
      label: seg.label,
      turnIds: seg.turnIds,
      status: "active" as const,
      totalTokens: seg.totalTokens,
      startTime: seg.startTime,
      endTime: seg.endTime,
    }));
  } catch {
    // 分段失败时回退到默认话题
    return buildDefaultTopic(turns);
  }
}

/**
 * 回填每个 Turn 的 topicId 字段。
 */
function backfillTopicIds(turns: TurnIndex[], topics: TopicIndex[]): void {
  const turnTopicMap = new Map<string, string>();
  for (const topic of topics) {
    for (const turnId of topic.turnIds) {
      turnTopicMap.set(turnId, topic.id);
    }
  }

  for (const turn of turns) {
    const topicId = turnTopicMap.get(turn.id);
    if (topicId) {
      turn.topicId = topicId;
    } else if (!turn.topicId && topics.length > 0) {
      // 如果没有匹配，就归入最后一个话题（active topic）
      const active = topics.find((t) => t.status === "active") ?? topics[topics.length - 1];
      turn.topicId = active.id;
    }
  }
}

function buildTurnLookup(turns: TurnIndex[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (let i = 0; i < turns.length; i++) {
    map[turns[i].id] = i;
  }
  return map;
}

function buildStats(
  turns: TurnIndex[],
  topics: TopicIndex[],
  parsed: ParsedLine[],
): IndexStats {
  let totalMessages = 0;
  let totalToolCalls = 0;
  const toolCallsByName: Record<string, number> = {};

  for (const turn of turns) {
    totalMessages += turn.messageCount;
    for (const tool of turn.toolsUsed) {
      toolCallsByName[tool] = (toolCallsByName[tool] ?? 0) + 1;
      totalToolCalls++;
    }
  }

  return {
    totalLines: parsed.length > 0 ? parsed[parsed.length - 1].line : 0,
    totalTurns: turns.length,
    totalTopics: topics.length,
    totalTokens: turns.reduce((sum, t) => sum + t.totalTokens, 0),
    totalMessages,
    totalToolCalls,
    toolCallsByName,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  增量合并
// ═══════════════════════════════════════════════════════════════════════════

async function mergeIncremental(
  existing: SessionIndex,
  newParsed: ParsedLine[],
  modifiedAt: string,
  segmenterConfig?: Partial<TopicSegmenterConfig>,
): Promise<SessionIndex> {
  // 更新 meta（可能有 model_change）
  const meta = { ...existing.meta };
  for (const line of newParsed) {
    if (line.type === "model_change") {
      meta.currentModel = {
        provider: line.provider ?? "",
        modelId: line.modelId ?? "",
      };
    }
  }

  // 构建新的 Turns
  const newTurns = buildTurns(newParsed);

  // 检查是否要合并到现有最后一个 Turn
  // （如果上次索引时最后一个 Turn 还没结束——即新数据的第一条不是 user）
  let mergedTurns: TurnIndex[];
  const firstNewMsg = newParsed.find((p) => p.type === "message");

  if (
    existing.turns.length > 0 &&
    firstNewMsg &&
    firstNewMsg.role !== "user" &&
    newTurns.length > 0
  ) {
    // 把新数据的第一个 "turn" 合并到现有最后一个 turn
    const lastExisting = existing.turns[existing.turns.length - 1];
    const firstNew = newTurns[0];
    const merged: TurnIndex = {
      ...lastExisting,
      lineEnd: firstNew.lineEnd,
      messageCount: lastExisting.messageCount + firstNew.messageCount,
      totalTokens: lastExisting.totalTokens + firstNew.totalTokens,
      tokenBreakdown: {
        user: (lastExisting.tokenBreakdown?.user ?? 0) + (firstNew.tokenBreakdown?.user ?? 0),
        assistant: (lastExisting.tokenBreakdown?.assistant ?? 0) + (firstNew.tokenBreakdown?.assistant ?? 0),
        toolResult: (lastExisting.tokenBreakdown?.toolResult ?? 0) + (firstNew.tokenBreakdown?.toolResult ?? 0),
      },
      toolsUsed: [...new Set([...lastExisting.toolsUsed, ...firstNew.toolsUsed])],
      toolCallCount: lastExisting.toolCallCount + firstNew.toolCallCount,
      hasError: lastExisting.hasError || firstNew.hasError,
      endTime: firstNew.endTime,
      assistantPreview: firstNew.assistantPreview || lastExisting.assistantPreview,
      importance: Math.max(lastExisting.importance, firstNew.importance),
    };
    mergedTurns = [
      ...existing.turns.slice(0, -1),
      merged,
      ...newTurns.slice(1).map((t, i) => ({
        ...t,
        sequence: existing.turns.length + i,
      })),
    ];
  } else {
    mergedTurns = [
      ...existing.turns,
      ...newTurns.map((t, i) => ({
        ...t,
        sequence: existing.turns.length + i,
      })),
    ];
  }

  // 重建 topic（使用 TopicSegmenter 增量分类新 Turn）
  const topics = await extendTopicsWithSegmenter(
    existing.topics,
    mergedTurns,
    newTurns,
    segmenterConfig,
  );
  backfillTopicIds(mergedTurns, topics);

  const turnById = buildTurnLookup(mergedTurns);
  const lastLine = newParsed.length > 0 ? newParsed[newParsed.length - 1].line : existing.indexedLineCount;

  const stats: IndexStats = {
    totalLines: lastLine,
    totalTurns: mergedTurns.length,
    totalTopics: topics.length,
    totalTokens: mergedTurns.reduce((sum, t) => sum + t.totalTokens, 0),
    totalMessages: mergedTurns.reduce((sum, t) => sum + t.messageCount, 0),
    totalToolCalls: mergedTurns.reduce((sum, t) => sum + t.toolsUsed.length, 0),
    toolCallsByName: countTools(mergedTurns),
  };

  return {
    version: 1,
    meta,
    turns: mergedTurns,
    topics,
    turnById,
    stats,
    builtAt: new Date().toISOString(),
    sessionFileModifiedAt: modifiedAt,
    indexedLineCount: lastLine,
  };
}

/**
 * 使用 TopicSegmenter 增量分类新 Turn，所有 Turn 都处理完返回更新后的 topics。
 */
async function extendTopicsWithSegmenter(
  existingTopics: TopicIndex[],
  allTurns: TurnIndex[],
  newTurns: TurnIndex[],
  segmenterConfig?: Partial<TopicSegmenterConfig>,
): Promise<TopicIndex[]> {
  if (allTurns.length === 0) return existingTopics;

  // 没有新 Turn，直接返回
  if (newTurns.length === 0) return existingTopics;

  // 构建当前话题分段（从现有 topic 转换）
  const existingSegments = topicIndexesToSegments(existingTopics, allTurns);

  // 创建不带 LLM 的 segmenter（增量场景不调 LLM）
  const segmenter = new TopicSegmenter({
    ...segmenterConfig,
    enableLlmConfirmation: false, // 增量场景不调 LLM
    llmClassify: undefined,
  });

  // 获取现有话题的最近几个 Turn 作为参考
  const currentTopic = existingSegments[existingSegments.length - 1];
  const recentTurnIds = currentTopic?.turnIds.slice(-3) ?? [];
  const allTurnsMap = new Map(allTurns.map((t) => [t.id, t]));
  const recentTurns = recentTurnIds
    .map((id) => allTurnsMap.get(id))
    .filter((t): t is TurnIndex => t !== undefined);

  // 对每个新 Turn 做增量分类
  let updatedSegments = existingSegments;
  for (const newTurn of newTurns) {
    const recentForThisTurn = updatedSegments[updatedSegments.length - 1]?.turnIds
      .slice(-3)
      .map((id) => allTurnsMap.get(id))
      .filter((t): t is TurnIndex => t !== undefined) ?? recentTurns;

    updatedSegments = await segmenter.classifyNewTurn(
      updatedSegments,
      newTurn,
      recentForThisTurn,
    );
  }

  // 将 segments 转回 TopicIndex
  return segmentsToTopicIndexes(updatedSegments, existingTopics);
}

/**
 * 将 TopicIndex 转换为 TopicSegment（用于传入 TopicSegmenter）。
 */
function topicIndexesToSegments(
  topics: TopicIndex[],
  allTurns: TurnIndex[],
): import("../topic/types.js").TopicSegment[] {
  if (topics.length === 0 || allTurns.length === 0) return [];

  const allTurnsMap = new Map(allTurns.map((t) => [t.id, t]));

  return topics.map((topic, i) => {
    const topicTurns = topic.turnIds
      .map((id) => allTurnsMap.get(id))
      .filter((t): t is TurnIndex => t !== undefined);

    return {
      topicId: topic.id,
      label: topic.label,
      turnIds: topic.turnIds,
      isCurrentTopic: i === topics.length - 1,
      totalTokens: topic.totalTokens,
      startTime: topicTurns[0]?.startTime ?? topic.startTime,
      endTime: topicTurns[topicTurns.length - 1]?.endTime ?? topic.endTime,
    };
  });
}

/**
 * 将 TopicSegment 列表转换回 TopicIndex 列表。
 * 保留现有话题的 status 和 summaryRef。
 */
function segmentsToTopicIndexes(
  segments: import("../topic/types.js").TopicSegment[],
  existingTopics: TopicIndex[],
): TopicIndex[] {
  const existingMap = new Map(existingTopics.map((t) => [t.id, t]));

  return segments.map((seg, i) => {
    const existing = existingMap.get(seg.topicId);
    return {
      id: seg.topicId,
      label: seg.label,
      turnIds: seg.turnIds,
      status: seg.isCurrentTopic ? "active" : (existing?.status ?? "active"),
      summaryRef: existing?.summaryRef,
      totalTokens: seg.totalTokens,
      startTime: seg.startTime,
      endTime: seg.endTime,
    } satisfies TopicIndex;
  });
}

function extendTopics(existingTopics: TopicIndex[], allTurns: TurnIndex[]): TopicIndex[] {
  if (allTurns.length === 0) return existingTopics;

  const active = existingTopics.find((t) => t.status === "active");
  const others = existingTopics.filter((t) => t.status !== "active");

  if (active) {
    const allTurnIds = allTurns.map((t) => t.id);
    return [
      ...others,
      {
        ...active,
        turnIds: allTurnIds,
        totalTokens: allTurns.reduce((sum, t) => sum + t.totalTokens, 0),
        endTime: allTurns[allTurns.length - 1].endTime,
      },
    ];
  }

  // 没有 active topic，创建一个
  return [
    ...others,
    {
      id: `topic-${allTurns[0].id}`,
      label: "default",
      turnIds: allTurns.map((t) => t.id),
      status: "active",
      totalTokens: allTurns.reduce((sum, t) => sum + t.totalTokens, 0),
      startTime: allTurns[0].startTime,
      endTime: allTurns[allTurns.length - 1].endTime,
    },
  ];
}

function countTools(turns: TurnIndex[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of turns) {
    for (const tool of turn.toolsUsed) {
      counts[tool] = (counts[tool] ?? 0) + 1;
    }
  }
  return counts;
}

// ═════════════════════════════════════════════════════════════════════════
//  Turn 重要性评分
// ═════════════════════════════════════════════════════════════════════════

/**
 * 计算 Turn 的重要性评分（0-100）。
 *
 * 评分维度：
 *   1. 用户消息复杂度：用户消息越长，问题越复杂，重要性越高
 *   2. 助手有实质回复：有文本回复 > 纯工具调用中转
 *   3. 工具出错：出错轮次包含诊断信息，重要性提升
 *   4. toolCall 密度：大量工具调用的轮次，原始数据体积大但信息密度低，重要性降低
 *
 * 压缩时，低分 Turn 优先被压缩。
 */
function computeTurnImportance(pending: PendingTurn): number {
  let score = 50; // 基础分

  // ── 用户消息复杂度 ────────────────────────────────────────────
  // 用户 token 越多，问题越复杂，重要性越高
  if (pending.userTokens > 500) score += 15;       // 长问题
  else if (pending.userTokens > 100) score += 8;   // 中等问题
  else if (pending.userTokens < 20) score -= 5;    // 非常短的消息（如 "好" "对"）

  // ── 助手回复质量 ─────────────────────────────────────────────
  if (pending.hasAssistantText) {
    score += 10; // 有实质文本回复，是面向用户的结果
  }
  // 纯 toolCall 中转（没有文本回复）重要性低
  if (!pending.hasAssistantText && pending.toolCallCount > 0) {
    score -= 10;
  }

  // ── 工具出错 ─────────────────────────────────────────────────
  if (pending.hasError) {
    score += 15; // 出错轮次包含诊断信息，压缩后难以恢复
  }

  // ── toolCall 密度 ──────────────────────────────────────────────
  // toolCall 比例越高，说明这轮主要是工具操作，原始数据大但信息密度低
  if (pending.messageCount > 0) {
    const toolRatio = pending.toolCallCount / pending.messageCount;
    if (toolRatio > 0.7) score -= 10;  // 大部分是工具调用
    if (toolRatio > 0.9) score -= 5;   // 几乎全是工具调用
  }

  // ── 工具类型权重 ───────────────────────────────────────────────
  // 根据工具类型调整重要性：
  //   有副作用的工具（edit/write/exec/message）→ 结果不可复现，压缩后难恢复
  //   只读工具（read/web_fetch/search）→ 数据源还在，随时能重新获取
  score += computeToolTypeWeight(pending.toolsUsed);

  return Math.max(0, Math.min(100, score));
}

/**
 * 工具信息保留价值权重。
 *
 * 正值 = 压缩后难以恢复，应保留原始消息
 * 负值 = 数据源仍在，可重新获取，优先压缩
 *
 * 分类逻辑：
 *   只读/查询类：数据源不变，随时重读，压缩代价低
 *   写入/修改类：改了什么很重要，压缩后丢失变更记录
 *   执行/发送类：命令输出可能无法复现（状态已变）
 */
const TOOL_RETENTION_WEIGHT: Record<string, number> = {
  // 只读/查询类 — 数据源仍在，可重新获取
  read:             -5,
  web_fetch:        -3,
  web_search:       -3,
  memory_search:    -2,
  memory_get:       -2,
  image:            -2,  // 图片分析，图片还在
  pdf:              -2,  // PDF 分析，文件还在
  session_status:   -3,
  sessions_list:    -3,
  sessions_history: -3,

  // 写入/修改类 — 变更记录重要
  edit:             +8,
  write:            +8,

  // 执行类 — 输出可能不可复现
  exec:             +5,

  // 发送/通信类 — 已发出，不可撤回
  message:          +5,
  sessions_send:    +5,
  sessions_spawn:   +4,
  tts:              +3,

  // 配置/管理类 — 变更有影响
  gateway:          +6,
  cron:             +5,
  knot_skills:      +3,

  // 企微类 — 外部操作
  wecom_mcp:        +4,
};

function computeToolTypeWeight(toolsUsed: Set<string>): number {
  if (toolsUsed.size === 0) return 0;

  let totalWeight = 0;
  let count = 0;

  for (const tool of toolsUsed) {
    const weight = TOOL_RETENTION_WEIGHT[tool] ?? 0;
    totalWeight += weight;
    count++;
  }

  // 取平均值，避免工具数量多时过度影响
  return count > 0 ? Math.round(totalWeight / count) : 0;
}
