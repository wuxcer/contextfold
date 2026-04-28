/**
 * Session Index — Types
 *
 * 基于 OpenClaw session JSONL 文件构建的索引结构。
 *
 * 设计目标：
 *   以 Turn（用户一轮完整对话）为核心索引单元。
 *   每个 Turn 记录其在 session 文件中的行号范围 [lineStart, lineEnd]。
 *   上下文压缩后，通过 TurnId → 行号范围 即可从 session 文件恢复原始消息。
 *
 * Session JSONL entry 类型：
 *   - session              : 会话元信息
 *   - model_change         : 模型切换
 *   - thinking_level_change: 思维级别切换
 *   - custom               : 自定义事件（如 model-snapshot）
 *   - message              : 消息（role = user | assistant | toolResult）
 */

// ═══════════════════════════════════════════════════════════════════════════
//  消息角色 & Entry 类型
// ═══════════════════════════════════════════════════════════════════════════

export type EntryType =
  | "session"
  | "model_change"
  | "thinking_level_change"
  | "custom"
  | "message";

export type MessageRole = "user" | "assistant" | "toolResult";

// ═══════════════════════════════════════════════════════════════════════════
//  Turn —— 索引的核心单元
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 一个 Turn = 用户一轮完整对话。
 *
 * 典型结构：
 *   line 5:  message (user)
 *   line 6:  message (assistant, 含 toolCall)
 *   line 7:  message (toolResult)
 *   line 8:  message (toolResult)
 *   line 9:  message (assistant, 含 toolCall)
 *   line 10: message (toolResult)
 *   line 11: message (assistant, 最终回复)
 *
 * → Turn { lineStart: 5, lineEnd: 11 }
 *
 * 恢复时，读取 session 文件第 5~11 行即可拿到该轮全部原始消息。
 */
export interface TurnIndex {
  /** Turn 唯一 ID（= 该轮 user 消息的 entryId） */
  id: string;
  /** 全局序号（0-based） */
  sequence: number;
  /** 在 session 文件中的起始行号（1-based） */
  lineStart: number;
  /** 在 session 文件中的结束行号（1-based, inclusive） */
  lineEnd: number;
  /** 本轮消息数量 */
  messageCount: number;
  /** 本轮涉及的工具名列表（去重） */
  toolsUsed: string[];
  /** 本轮 toolCall 次数 */
  toolCallCount: number;
  /** 本轮总 token 估算 */
  totalTokens: number;
  /** 本轮 user 消息的文本预览（前 200 字符） */
  userPreview: string;
  /** 本轮 assistant 最终回复的文本预览（前 200 字符） */
  assistantPreview: string;
  /** 时间范围 */
  startTime: string;
  endTime: string;
  /** 所属 Topic ID */
  topicId: string;
  /** 本轮是否包含工具调用出错 */
  hasError: boolean;
  /**
   * 重要性评分（0-100）。
   * 用于 compaction 时决定压缩优先级：分数越低越优先被压缩。
   *
   * 评分维度：
   *   - 用户消息长度：长问题 > 短问题（信息量更大）
   *   - 助手回复有文本：有实质回复 > 纯 toolCall 中转
   *   - 工具出错：出错轮次更重要（包含诊断信息）
   *   - toolCall 密度：纯工具操作轮重要性较低
   */
  importance: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Topic —— Turn 的语义分组
// ═══════════════════════════════════════════════════════════════════════════

export type TopicStatus = "active" | "summarized" | "distilled" | "archived";

export interface TopicIndex {
  id: string;
  label: string;
  turnIds: string[];
  status: TopicStatus;
  /** 如果已摘要，关联的摘要信息 */
  summaryRef?: SummaryRef;
  totalTokens: number;
  startTime: string;
  endTime: string;
}

export interface SummaryRef {
  summaryId: string;
  tokenCount: number;
  originalTokenCount: number;
  createdAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Session Index —— 顶层结构
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionIndex {
  /** 索引版本 */
  version: number;
  /** Session 元信息 */
  meta: SessionMeta;
  /** Turn 索引列表（按 sequence 排列） */
  turns: TurnIndex[];
  /** Topic 索引列表 */
  topics: TopicIndex[];
  /** Turn ID → turns 数组下标 */
  turnById: Record<string, number>;
  /** 统计信息 */
  stats: IndexStats;
  /** 索引构建时间 */
  builtAt: string;
  /** session 文件最后修改时间（用于判断是否过期） */
  sessionFileModifiedAt: string;
  /** 已索引到的行数（用于增量更新） */
  indexedLineCount: number;
}

export interface SessionMeta {
  sessionId: string;
  sessionFile: string;
  sessionVersion: number;
  cwd: string;
  createdAt: string;
  currentModel: {
    provider: string;
    modelId: string;
  };
}

export interface IndexStats {
  /** JSONL 文件总行数 */
  totalLines: number;
  /** Turn 总数 */
  totalTurns: number;
  /** Topic 总数 */
  totalTopics: number;
  /** 所有 Turn 的 token 总估算 */
  totalTokens: number;
  /** 总消息数（user + assistant + toolResult） */
  totalMessages: number;
  /** 工具调用总次数 */
  totalToolCalls: number;
  /** 按工具名统计调用次数 */
  toolCallsByName: Record<string, number>;
}
