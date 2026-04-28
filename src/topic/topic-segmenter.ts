/**
 * Topic Segmenter — 话题分段核心类
 *
 * 组合 embedding 检测和 LLM 确认两层检测，
 * 对外提供统一的话题分段接口。
 *
 * 用途：
 *   1. segment(turns) — 全量分段：对一组 Turn 做完整话题分析
 *   2. classifyNewTurn(...) — 增量分类：判断新 Turn 是否属于当前话题
 */

import type { TurnIndex } from "../session-index/types.js";
import type { TopicBoundary, TopicSegment, TopicSegmenterConfig } from "./types.js";
import { DEFAULT_TOPIC_SEGMENTER_CONFIG } from "./types.js";
import {
  detectBoundariesByEmbedding,
  computeTurnSimilarityToGroup,
} from "./embedding-detector.js";
import { confirmBoundariesByLlm, generateTopicLabel } from "./llm-classifier.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Topic Segmenter
// ═══════════════════════════════════════════════════════════════════════════

export class TopicSegmenter {
  private config: TopicSegmenterConfig;

  /**
   * @param config 部分配置，未提供的字段使用默认值
   */
  constructor(config: Partial<TopicSegmenterConfig> = {}) {
    this.config = { ...DEFAULT_TOPIC_SEGMENTER_CONFIG, ...config };
  }

  // ── 全量分段 ────────────────────────────────────────────────────────────

  /**
   * 对一组 Turns 做完整话题分段。
   *
   * 流程：
   *   1. Embedding 检测所有疑似边界
   *   2. LLM 确认（如果启用且配置了 llmClassify）
   *   3. 根据确认后的边界切分 Turn 列表为 TopicSegment
   *   4. 最后一个 segment 标记为 isCurrentTopic = true
   *   5. 对于 turn 数少于 minTurnsPerTopic 的 segment，合并到相邻 segment
   *
   * @param turns Turn 索引列表（按 sequence 排序）
   * @returns 话题分段列表
   */
  async segment(turns: TurnIndex[]): Promise<TopicSegment[]> {
    if (turns.length === 0) return [];

    // 单个 Turn：直接返回一个话题
    if (turns.length === 1) {
      return [buildSingleSegment(turns, 0, this.config)];
    }

    // ── Step 1: Embedding 检测 ──────────────────────────────────────────
    let boundaries = detectBoundariesByEmbedding(turns, this.config);

    // ── Step 2: LLM 确认（可选）──────────────────────────────────────────
    if (
      this.config.enableLlmConfirmation &&
      this.config.llmClassify &&
      boundaries.length > 0
    ) {
      boundaries = await confirmBoundariesByLlm(boundaries, turns, this.config);
    }

    // ── Step 3: 按边界切分 Turns ──────────────────────────────────────────
    let segments = splitTurnsByBoundaries(turns, boundaries, this.config);

    // ── Step 4: 合并过短的 segment ─────────────────────────────────────────
    segments = mergeShortSegments(segments, turns, this.config.minTurnsPerTopic);

    // ── Step 5: 标记当前话题 ────────────────────────────────────────────────
    if (segments.length > 0) {
      segments[segments.length - 1] = {
        ...segments[segments.length - 1],
        isCurrentTopic: true,
      };
    }

    return segments;
  }

  // ── 增量分类 ─────────────────────────────────────────────────────────────

  /**
   * 增量更新：新增 Turn 时判断是否属于当前话题。
   *
   * 流程（不调 LLM，追求速度）：
   *   1. 获取当前话题（最后一个 segment）
   *   2. 对比新 Turn 和当前话题最后几个 Turn 的 embedding 相似度
   *   3. 相似度高 → 归入当前话题
   *   4. 相似度低 → 开启新话题
   *
   * @param existingSegments 现有话题分段列表
   * @param newTurn 新增的 Turn
   * @param recentTurns 用于相似度比较的最近 Turn（通常是当前话题的最后几个）
   * @returns 更新后的话题分段列表
   */
  async classifyNewTurn(
    existingSegments: TopicSegment[],
    newTurn: TurnIndex,
    recentTurns: TurnIndex[],
  ): Promise<TopicSegment[]> {
    // 没有现有分段：创建第一个话题
    if (existingSegments.length === 0) {
      return [
        {
          topicId: generateTopicId(newTurn),
          label: generateTopicLabel([newTurn.id], new Map([[newTurn.id, newTurn]]), 0),
          turnIds: [newTurn.id],
          isCurrentTopic: true,
          totalTokens: newTurn.totalTokens,
          startTime: newTurn.startTime,
          endTime: newTurn.endTime,
        },
      ];
    }

    // 计算新 Turn 与当前话题最近几个 Turn 的相似度
    // 取最近 3 个 Turn 作为参考（平衡精度与速度）
    const referenceCount = 3;
    const referenceTurns = recentTurns.slice(-referenceCount);

    const similarity = computeTurnSimilarityToGroup(newTurn, referenceTurns);

    const threshold = this.config.embeddingSimilarityThreshold;

    // 更新现有最后一个 segment，先标为非当前话题
    const updatedSegments = existingSegments.map((s, i) => ({
      ...s,
      isCurrentTopic: i === existingSegments.length - 1 ? false : s.isCurrentTopic,
    }));

    if (similarity >= threshold) {
      // ── 相似度高：归入当前话题 ──────────────────────────────────────
      const lastIdx = updatedSegments.length - 1;
      const lastSegment = updatedSegments[lastIdx];

      updatedSegments[lastIdx] = {
        ...lastSegment,
        turnIds: [...lastSegment.turnIds, newTurn.id],
        isCurrentTopic: true,
        totalTokens: lastSegment.totalTokens + newTurn.totalTokens,
        endTime: newTurn.endTime,
      };
    } else {
      // ── 相似度低：开启新话题 ────────────────────────────────────────
      const topicIndex = updatedSegments.length;
      const turnsMap = new Map<string, TurnIndex>([[newTurn.id, newTurn]]);

      updatedSegments.push({
        topicId: generateTopicId(newTurn),
        label: generateTopicLabel([newTurn.id], turnsMap, topicIndex),
        turnIds: [newTurn.id],
        isCurrentTopic: true,
        totalTokens: newTurn.totalTokens,
        startTime: newTurn.startTime,
        endTime: newTurn.endTime,
      });
    }

    return updatedSegments;
  }

  /** 获取当前配置（只读副本） */
  getConfig(): TopicSegmenterConfig {
    return { ...this.config };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  私有辅助函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为 Turn 生成 Topic ID。
 * 格式：topic-{turnId}
 */
function generateTopicId(firstTurn: TurnIndex): string {
  return `topic-${firstTurn.id}`;
}

/**
 * 当只有一个 Turn 时，构建单个 TopicSegment。
 */
function buildSingleSegment(
  turns: TurnIndex[],
  topicIndex: number,
  _config: TopicSegmenterConfig,
): TopicSegment {
  const turnsMap = new Map(turns.map((t) => [t.id, t]));
  const turnIds = turns.map((t) => t.id);

  return {
    topicId: generateTopicId(turns[0]),
    label: generateTopicLabel(turnIds, turnsMap, topicIndex),
    turnIds,
    isCurrentTopic: false,
    totalTokens: turns.reduce((sum, t) => sum + t.totalTokens, 0),
    startTime: turns[0].startTime,
    endTime: turns[turns.length - 1].endTime,
  };
}

/**
 * 根据话题边界将 Turns 切分为 TopicSegment 列表。
 *
 * @param turns 所有 Turn（按 sequence 排序）
 * @param boundaries 话题边界列表（按 turnSequence 排序）
 * @param config 配置
 * @returns TopicSegment 列表
 */
function splitTurnsByBoundaries(
  turns: TurnIndex[],
  boundaries: TopicBoundary[],
  config: TopicSegmenterConfig,
): TopicSegment[] {
  if (boundaries.length === 0) {
    // 没有边界：所有 Turn 归入一个话题
    return [buildSingleSegment(turns, 0, config)];
  }

  // 按 sequence 排序边界
  const sortedBoundaries = [...boundaries].sort(
    (a, b) => a.turnSequence - b.turnSequence,
  );

  // 构建切分点集合（边界前的 Turn sequence）
  const boundarySet = new Set(sortedBoundaries.map((b) => b.turnSequence));
  // 边界到标签的映射
  const boundaryLabels = new Map(
    sortedBoundaries.map((b) => [b.turnSequence, b]),
  );

  const segments: TopicSegment[] = [];
  let currentGroup: TurnIndex[] = [];
  let topicIndex = 0;
  let prevBoundary: TopicBoundary | null = null;

  for (const turn of turns) {
    if (boundarySet.has(turn.sequence) && currentGroup.length > 0) {
      // 遇到边界：关闭当前 segment，开启新 segment
      const boundary = boundaryLabels.get(turn.sequence)!;

      // 确定当前 segment 的标签
      const label =
        prevBoundary?.nextTopicLabel ??
        generateTopicLabel(
          currentGroup.map((t) => t.id),
          new Map(currentGroup.map((t) => [t.id, t])),
          topicIndex,
        );

      segments.push(buildSegmentFromTurns(currentGroup, topicIndex, label));
      topicIndex++;
      currentGroup = [];
      prevBoundary = boundary;
    }

    currentGroup.push(turn);
  }

  // 处理最后一组
  if (currentGroup.length > 0) {
    const label =
      prevBoundary?.nextTopicLabel ??
      generateTopicLabel(
        currentGroup.map((t) => t.id),
        new Map(currentGroup.map((t) => [t.id, t])),
        topicIndex,
      );
    segments.push(buildSegmentFromTurns(currentGroup, topicIndex, label));
  }

  return segments;
}

/**
 * 从一组 Turn 构建 TopicSegment。
 */
function buildSegmentFromTurns(
  turns: TurnIndex[],
  topicIndex: number,
  label: string,
): TopicSegment {
  return {
    topicId: generateTopicId(turns[0]),
    label,
    turnIds: turns.map((t) => t.id),
    isCurrentTopic: false,
    totalTokens: turns.reduce((sum, t) => sum + t.totalTokens, 0),
    startTime: turns[0].startTime,
    endTime: turns[turns.length - 1].endTime,
  };
}

/**
 * 合并过短的 TopicSegment（turn 数少于 minTurnsPerTopic 的 segment）。
 *
 * 合并规则：
 *   - 前后都有邻居：合并到更大的相邻 segment
 *   - 只有前邻居：合并到前面
 *   - 只有后邻居：合并到后面
 *
 * @param segments 原始分段列表
 * @param turns 所有 Turn（按 sequence 排序，用于重建 Turn 对象）
 * @param minTurns 最少 Turn 数
 * @returns 合并后的分段列表
 */
function mergeShortSegments(
  segments: TopicSegment[],
  _turns: TurnIndex[],
  minTurns: number,
): TopicSegment[] {
  if (segments.length <= 1) return segments;

  let result = [...segments];
  let changed = true;

  // 迭代合并，直到所有 segment 都满足最小 turn 数
  while (changed) {
    changed = false;

    for (let i = 0; i < result.length; i++) {
      if (result[i].turnIds.length < minTurns && result.length > 1) {
        // 决定合并方向：优先合并到更大的邻居
        let mergeIdx: number;

        if (i === 0) {
          mergeIdx = 1; // 只有后邻居
        } else if (i === result.length - 1) {
          mergeIdx = i - 1; // 只有前邻居
        } else {
          // 选较大的邻居
          const prevSize = result[i - 1].turnIds.length;
          const nextSize = result[i + 1].turnIds.length;
          mergeIdx = prevSize >= nextSize ? i - 1 : i + 1;
        }

        // 执行合并
        const a = result[Math.min(i, mergeIdx)];
        const b = result[Math.max(i, mergeIdx)];

        const merged: TopicSegment = {
          // 保留先出现的 topic 的 ID 和标签
          topicId: a.topicId,
          label: a.label,
          turnIds: [...a.turnIds, ...b.turnIds],
          isCurrentTopic: a.isCurrentTopic || b.isCurrentTopic,
          totalTokens: a.totalTokens + b.totalTokens,
          startTime: a.startTime,
          endTime: b.endTime,
        };

        // 替换两个 segment 为合并后的 segment
        const newResult: TopicSegment[] = [];
        const mergeMin = Math.min(i, mergeIdx);
        const mergeMax = Math.max(i, mergeIdx);

        for (let j = 0; j < result.length; j++) {
          if (j === mergeMin) {
            newResult.push(merged);
          } else if (j === mergeMax) {
            // 跳过，已合并
          } else {
            newResult.push(result[j]);
          }
        }

        result = newResult;
        changed = true;
        break; // 重新扫描
      }
    }
  }

  return result;
}
