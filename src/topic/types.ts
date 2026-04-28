/**
 * Topic Segmentation — Types
 *
 * 话题分隔相关类型定义。
 * 用于将 Turn 序列按语义主题进行分段，
 * 以便跨话题的旧 Turn 可以更激进地压缩或丢弃。
 */

// ═══════════════════════════════════════════════════════════════════════════
//  话题边界
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 话题边界检测结果。
 * 表示在某个 Turn 之前存在话题切换。
 */
export interface TopicBoundary {
  /**
   * 边界位置：在此 sequence 的 Turn 之前切分。
   * 例如 turnSequence=3 表示 Turn#2 结束一个话题，Turn#3 开启新话题。
   */
  turnSequence: number;

  /** 检测方法 */
  method: "embedding" | "llm" | "explicit";

  /**
   * 置信度 (0-1)。
   * embedding 检测：基于余弦相似度反向映射
   * llm 检测：LLM 返回的 isBoundary 置信度
   * explicit：人工标注，固定为 1.0
   */
  confidence: number;

  /** LLM 生成的前一个话题标签（如有） */
  prevTopicLabel?: string;

  /** LLM 生成的后一个话题标签（如有） */
  nextTopicLabel?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  话题分段结果
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 话题分段结果：一组语义相关的 Turn 集合。
 * 对应 session-index/types.ts 中的 TopicIndex。
 */
export interface TopicSegment {
  /** Topic 唯一 ID */
  topicId: string;

  /** 话题标签（人类可读的短标题） */
  label: string;

  /** 本话题包含的 Turn ID 列表（有序） */
  turnIds: string[];

  /** 是否为当前活跃话题（最后一个 segment） */
  isCurrentTopic: boolean;

  /** 本话题的 token 总量 */
  totalTokens: number;

  /** 话题开始时间（第一个 Turn 的 startTime） */
  startTime: string;

  /** 话题结束时间（最后一个 Turn 的 endTime） */
  endTime: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  TopicSegmenter 配置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TopicSegmenter 的配置。
 * 所有字段都有默认值，可以部分覆盖。
 */
export interface TopicSegmenterConfig {
  /**
   * Embedding 相似度阈值。
   * 相邻 Turn 的余弦相似度低于此值时视为"疑似话题边界"。
   * 范围: 0-1，越低越保守（更少边界），越高越激进（更多边界）。
   * 默认: 0.3
   */
  embeddingSimilarityThreshold: number;

  /**
   * 最少几个 Turn 才能构成一个独立话题。
   * 少于此值的话题会被合并到相邻话题。
   * 默认: 2
   */
  minTurnsPerTopic: number;

  /**
   * 是否启用 LLM 确认边界。
   * true：用 LLM 二次确认 embedding 检测的疑似边界，同时生成话题标签
   * false：只用 embedding 检测，标签使用自动生成的简短描述
   * 默认: true（但没有配置 llmClassify 时自动降级为 false）
   */
  enableLlmConfirmation: boolean;

  /**
   * LLM 分类函数（可选）。
   * 复用 SummarizeFn 的类型：(input, context) => Promise<string>
   * 输入：边界上下文（前后各 1-2 个 Turn 的预览）
   * 输出：JSON 字符串，格式：{ "isBoundary": bool, "prevTopicLabel": string, "nextTopicLabel": string }
   */
  llmClassify?: (input: string, context: string) => Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  默认配置
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_TOPIC_SEGMENTER_CONFIG: TopicSegmenterConfig = {
  embeddingSimilarityThreshold: 0.05,
  minTurnsPerTopic: 2,
  enableLlmConfirmation: true,
};
