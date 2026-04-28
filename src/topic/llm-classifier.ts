/**
 * LLM Classifier — 话题边界 LLM 确认
 *
 * 第二层话题边界检测：对 embedding 检测到的疑似边界，
 * 用 LLM 精确确认并生成话题标签。
 *
 * 设计原则：
 *   - 只对 embedding 检测出的"疑似边界"做 LLM 确认（节省 token）
 *   - 每次调用只发送边界前后各 1-2 个 Turn 的预览（控制 token 成本）
 *   - 如果 LLM 函数未配置或调用失败，直接返回 embedding 结果
 *   - LLM 返回 JSON：{ "isBoundary": bool, "prevTopicLabel": string, "nextTopicLabel": string }
 */

import type { TurnIndex } from "../session-index/types.js";
import type { TopicBoundary, TopicSegmenterConfig } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  辅助函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构建发送给 LLM 的提示文本。
 *
 * 只发送边界前后各最多 2 个 Turn 的 userPreview + assistantPreview，
 * 控制 token 成本。
 *
 * @param boundary 待确认的话题边界
 * @param turns 所有 Turn 列表（按 sequence 排序）
 * @returns LLM 提示文本
 */
function buildClassificationPrompt(
  boundary: TopicBoundary,
  turns: TurnIndex[],
): string {
  // 找到边界前后的 Turn（各最多 2 个）
  const prevTurns = turns.filter(
    (t) => t.sequence < boundary.turnSequence,
  ).slice(-2);

  const nextTurns = turns.filter(
    (t) => t.sequence >= boundary.turnSequence,
  ).slice(0, 2);

  const formatTurns = (ts: TurnIndex[]): string => {
    return ts
      .map(
        (t) =>
          `  Turn #${t.sequence}:\n` +
          `    User: ${t.userPreview.slice(0, 150)}\n` +
          `    Assistant: ${t.assistantPreview.slice(0, 150)}` +
          (t.toolsUsed.length > 0 ? `\n    Tools: ${t.toolsUsed.join(", ")}` : ""),
      )
      .join("\n");
  };

  return [
    "You are analyzing a conversation to detect topic changes.",
    "",
    "Previous turns (before the potential boundary):",
    formatTurns(prevTurns) || "  (none)",
    "",
    "Next turns (after the potential boundary):",
    formatTurns(nextTurns) || "  (none)",
    "",
    "Does the conversation topic change between the previous and next turns?",
    "",
    'Respond with ONLY a JSON object in this exact format:',
    '{"isBoundary": true/false, "prevTopicLabel": "short label for previous topic", "nextTopicLabel": "short label for next topic"}',
    "",
    "Keep topic labels concise (3-8 words). If isBoundary is false, both labels can be the same.",
  ].join("\n");
}

/**
 * 解析 LLM 返回的 JSON 结果。
 * 健壮处理：允许 LLM 返回带有多余文本的 JSON。
 *
 * @param llmOutput LLM 输出字符串
 * @returns 解析结果，失败时返回 null
 */
function parseLlmClassifyResult(llmOutput: string): {
  isBoundary: boolean;
  prevTopicLabel: string;
  nextTopicLabel: string;
} | null {
  // 尝试直接解析
  try {
    const result = JSON.parse(llmOutput.trim()) as {
      isBoundary: boolean;
      prevTopicLabel: string;
      nextTopicLabel: string;
    };
    if (typeof result.isBoundary === "boolean") {
      return {
        isBoundary: result.isBoundary,
        prevTopicLabel: result.prevTopicLabel ?? "Previous topic",
        nextTopicLabel: result.nextTopicLabel ?? "New topic",
      };
    }
  } catch {
    // 直接解析失败，尝试提取 JSON 块
  }

  // 提取 JSON 块（LLM 可能在 JSON 前后加了文字说明）
  const jsonMatch = llmOutput.match(/\{[^{}]*"isBoundary"[^{}]*\}/s);
  if (jsonMatch) {
    try {
      const result = JSON.parse(jsonMatch[0]) as {
        isBoundary: boolean;
        prevTopicLabel: string;
        nextTopicLabel: string;
      };
      if (typeof result.isBoundary === "boolean") {
        return {
          isBoundary: result.isBoundary,
          prevTopicLabel: result.prevTopicLabel ?? "Previous topic",
          nextTopicLabel: result.nextTopicLabel ?? "New topic",
        };
      }
    } catch {
      // 提取也失败
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  主确认函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 用 LLM 确认话题边界，并为每个话题生成标签。
 *
 * 流程：
 *   1. 检查是否配置了 LLM 函数，未配置则直接返回 embedding 结果
 *   2. 对每个疑似边界构建提示，调用 LLM
 *   3. 解析 LLM 结果：
 *      - isBoundary=true → 更新 method="llm"，填入话题标签
 *      - isBoundary=false → 从结果中移除该边界
 *      - LLM 调用失败 → 保留 embedding 结果（不修改）
 *   4. 返回确认后的边界列表
 *
 * @param boundaries embedding 检测到的疑似边界
 * @param turns 所有 Turn 列表（按 sequence 排序）
 * @param config TopicSegmenter 配置
 * @returns 经 LLM 确认后的边界列表
 */
export async function confirmBoundariesByLlm(
  boundaries: TopicBoundary[],
  turns: TurnIndex[],
  config: TopicSegmenterConfig,
): Promise<TopicBoundary[]> {
  // 未配置 LLM 或禁用了 LLM 确认，直接返回
  if (!config.llmClassify || !config.enableLlmConfirmation) {
    return boundaries;
  }

  if (boundaries.length === 0) return boundaries;

  const confirmed: TopicBoundary[] = [];

  for (const boundary of boundaries) {
    try {
      const prompt = buildClassificationPrompt(boundary, turns);
      const context = `Checking topic boundary before Turn #${boundary.turnSequence} (embedding confidence: ${(boundary.confidence * 100).toFixed(0)}%)`;

      const llmOutput = await config.llmClassify(prompt, context);
      const result = parseLlmClassifyResult(llmOutput);

      if (result === null) {
        // 解析失败：保留 embedding 结果
        confirmed.push(boundary);
        continue;
      }

      if (result.isBoundary) {
        // LLM 确认是边界：更新方法和标签
        confirmed.push({
          ...boundary,
          method: "llm",
          prevTopicLabel: result.prevTopicLabel,
          nextTopicLabel: result.nextTopicLabel,
          // LLM 确认的置信度提升到 0.9+（比 embedding 结果更可信）
          confidence: Math.max(boundary.confidence, 0.9),
        });
      }
      // LLM 说不是边界：丢弃该边界（不加入 confirmed）

    } catch {
      // LLM 调用失败：保留 embedding 结果，不崩溃
      confirmed.push(boundary);
    }
  }

  return confirmed;
}

/**
 * 为单个话题生成简短标签（不调用 LLM 的情况下使用）。
 *
 * 从话题中最重要的 Turn 提取关键词作为标签。
 * 策略：取 userPreview 的前几个词
 *
 * @param turnIds 话题中的 Turn ID 列表
 * @param turnsMap Turn ID → TurnIndex 映射
 * @param topicIndex 话题序号（用于生成备用标签）
 * @returns 话题标签字符串
 */
export function generateTopicLabel(
  turnIds: string[],
  turnsMap: Map<string, TurnIndex>,
  topicIndex: number,
): string {
  if (turnIds.length === 0) {
    return `Topic ${topicIndex + 1}`;
  }

  // 取第一个 Turn 的用户预览作为标签基础
  const firstTurn = turnsMap.get(turnIds[0]);
  if (!firstTurn) return `Topic ${topicIndex + 1}`;

  const preview = firstTurn.userPreview.trim();
  if (!preview) return `Topic ${topicIndex + 1}`;

  // 截取前 40 个字符，在词边界处截断
  const maxLen = 40;
  if (preview.length <= maxLen) return preview;

  // 在词边界截断
  const truncated = preview.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  const lastCJKBreak = Math.max(
    truncated.length - 1,
    // 找最后一个 CJK 字符位置作为截断点
  );

  if (lastSpace > maxLen * 0.6) {
    return truncated.slice(0, lastSpace) + "...";
  }

  // 对于纯中文，直接按字数截断
  return truncated + "...";
}
