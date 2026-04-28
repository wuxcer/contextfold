/**
 * Sub-topic Detector — LLM 驱动的子话题分隔
 *
 * 在同一大话题（由 embedding 检测归为一组的 Turn）内，
 * 用 LLM 识别更细粒度的子话题边界。
 *
 * 设计原则：
 *   - 在 compact 阶段触发，不在 build 阶段（避免实时开销）
 *   - 一次 LLM 调用处理一整个大话题内的所有 Turn（只发 userPreview）
 *   - 结果缓存到磁盘，不重复调用
 *   - 没有 LLM 函数时，回退到启发式检测
 */

import type { TurnIndex } from "../session-index/types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

/** 子话题分段 */
export interface SubTopic {
  /** 子话题 ID */
  id: string;
  /** 子话题标签（简短描述） */
  label: string;
  /** 包含的 Turn sequence 列表 */
  turnSequences: number[];
  /** 是否为当前进行中的子话题（最后一个） */
  isCurrent: boolean;
}

/** 子话题检测结果 */
export interface SubTopicResult {
  /** 所属大话题 ID */
  topicId: string;
  /** 子话题列表 */
  subtopics: SubTopic[];
  /** 检测方式 */
  method: "llm" | "heuristic";
  /** 生成时间 */
  createdAt: string;
}

/** LLM 分类函数 */
export type LlmClassifyFn = (input: string, context: string) => Promise<string>;

// ═══════════════════════════════════════════════════════════════════════════
//  LLM 子话题检测
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 构建发给 LLM 的子话题分割 prompt。
 *
 * 只发送每个 Turn 的 userPreview + assistantPreview（简短摘要），
 * token 成本很低（通常 < 2000 tokens）。
 */
function buildSubTopicPrompt(turns: TurnIndex[]): string {
  const turnList = turns.map((t) => {
    const tools = t.toolsUsed.length > 0 ? ` [tools: ${t.toolsUsed.join(", ")}]` : "";
    return `#${t.sequence}: User: ${t.userPreview.slice(0, 100)} → Assistant: ${t.assistantPreview.slice(0, 100)}${tools}`;
  }).join("\n");

  return [
    "You are analyzing a conversation to identify sub-topic transitions within the SAME overall topic.",
    "These turns all belong to one topic, but the user may have shifted between different sub-tasks.",
    "",
    "For example, in a 'plugin development' topic:",
    "  - Sub-topic 1: 'Plugin registration & config' (turns 0-5)",
    "  - Sub-topic 2: 'Debugging 502 errors' (turns 6-8)",
    "  - Sub-topic 3: 'Developing topic segmentation feature' (turns 9-15)",
    "",
    "Conversation turns:",
    turnList,
    "",
    "Identify sub-topic groups. Respond with ONLY a JSON array:",
    '[{"label": "short description", "turns": [0, 1, 2]}, {"label": "...", "turns": [3, 4, 5]}]',
    "",
    "Rules:",
    "- Each turn sequence number must appear in exactly one group",
    "- Groups must be contiguous (no gaps or reordering)",
    "- Keep labels concise (3-10 words, can be Chinese or English)",
    "- If there's truly only one sub-topic, return a single group with all turns",
    "- Minimum 2 turns per sub-topic (merge tiny groups into neighbors)",
  ].join("\n");
}

/**
 * 解析 LLM 返回的子话题分组 JSON。
 */
function parseLlmSubTopicResult(
  llmOutput: string,
  turns: TurnIndex[],
): SubTopic[] | null {
  // 尝试提取 JSON 数组
  let jsonStr = llmOutput.trim();

  // 可能包裹在 markdown 代码块中
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // 尝试找到 JSON 数组
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return null;

  try {
    const parsed = JSON.parse(arrayMatch[0]) as Array<{
      label: string;
      turns: number[];
    }>;

    if (!Array.isArray(parsed) || parsed.length === 0) return null;

    // 验证所有 turn sequence 都被覆盖
    const allSeqs = new Set(turns.map((t) => t.sequence));
    const coveredSeqs = new Set<number>();
    for (const group of parsed) {
      if (!group.label || !Array.isArray(group.turns)) return null;
      for (const seq of group.turns) {
        coveredSeqs.add(seq);
      }
    }

    // 允许部分覆盖（LLM 可能漏掉一些），但至少要覆盖 80%
    const coverage = coveredSeqs.size / allSeqs.size;
    if (coverage < 0.8) return null;

    // 构建 SubTopic 列表
    const subtopics: SubTopic[] = parsed.map((group, i) => ({
      id: `subtopic-${i}`,
      label: group.label,
      turnSequences: group.turns.sort((a, b) => a - b),
      isCurrent: i === parsed.length - 1,
    }));

    return subtopics;
  } catch {
    return null;
  }
}

/**
 * 用 LLM 检测同一大话题内的子话题边界。
 *
 * @param topicId 大话题 ID
 * @param turns 该大话题下的所有 Turn（按 sequence 排序）
 * @param llmClassify LLM 分类函数
 * @returns 子话题检测结果
 */
export async function detectSubTopicsByLlm(
  topicId: string,
  turns: TurnIndex[],
  llmClassify: LlmClassifyFn,
): Promise<SubTopicResult> {
  if (turns.length <= 2) {
    // 太少的 turn，直接归为一个子话题
    return {
      topicId,
      subtopics: [{
        id: "subtopic-0",
        label: turns[0]?.userPreview.slice(0, 40) || "conversation",
        turnSequences: turns.map((t) => t.sequence),
        isCurrent: true,
      }],
      method: "llm",
      createdAt: new Date().toISOString(),
    };
  }

  const prompt = buildSubTopicPrompt(turns);
  const context = `Detecting sub-topics within topic ${topicId} (${turns.length} turns)`;

  try {
    const llmOutput = await llmClassify(prompt, context);
    const subtopics = parseLlmSubTopicResult(llmOutput, turns);

    if (subtopics && subtopics.length > 0) {
      return {
        topicId,
        subtopics,
        method: "llm",
        createdAt: new Date().toISOString(),
      };
    }
  } catch {
    // LLM 调用失败，回退到启发式
  }

  // 回退到启发式检测
  return detectSubTopicsByHeuristic(topicId, turns);
}

// ═══════════════════════════════════════════════════════════════════════════
//  启发式子话题检测（LLM 不可用时的回退方案）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 启发式子话题检测。
 *
 * 基于以下信号判断子话题边界：
 *   1. 时间间隔：两个 Turn 之间超过 10 分钟 → 可能切换了子话题
 *   2. 工具变化：前后 Turn 使用的工具集完全不同 → 任务类型转换
 *   3. 用户消息长度突变：短消息后突然出现长消息 → 新任务开始
 */
export function detectSubTopicsByHeuristic(
  topicId: string,
  turns: TurnIndex[],
): SubTopicResult {
  if (turns.length <= 2) {
    return {
      topicId,
      subtopics: [{
        id: "subtopic-0",
        label: turns[0]?.userPreview.slice(0, 40) || "conversation",
        turnSequences: turns.map((t) => t.sequence),
        isCurrent: true,
      }],
      method: "heuristic",
      createdAt: new Date().toISOString(),
    };
  }

  const boundaries: number[] = []; // Turn index (not sequence) where a boundary occurs

  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const curr = turns[i];
    let score = 0;

    // Signal 1: 时间间隔
    const prevTime = new Date(prev.endTime).getTime();
    const currTime = new Date(curr.startTime).getTime();
    if (!isNaN(prevTime) && !isNaN(currTime)) {
      const gapMinutes = (currTime - prevTime) / 60000;
      if (gapMinutes > 10) score += 2;
      if (gapMinutes > 30) score += 1;
    }

    // Signal 2: 工具集变化
    const prevTools = new Set(prev.toolsUsed);
    const currTools = new Set(curr.toolsUsed);
    if (prevTools.size > 0 && currTools.size > 0) {
      let overlap = 0;
      for (const t of prevTools) {
        if (currTools.has(t)) overlap++;
      }
      const unionSize = new Set([...prevTools, ...currTools]).size;
      const jaccard = unionSize > 0 ? overlap / unionSize : 1;
      if (jaccard === 0) score += 2; // 完全不同的工具
      else if (jaccard < 0.3) score += 1;
    }

    // Signal 3: 用户消息长度突变（短→长，可能是新任务描述）
    const prevLen = prev.userPreview.length;
    const currLen = curr.userPreview.length;
    if (prevLen < 30 && currLen > 80) score += 1;

    // 综合判断：score >= 3 视为子话题边界
    if (score >= 3) {
      boundaries.push(i);
    }
  }

  // 按边界切分
  const subtopics: SubTopic[] = [];
  let start = 0;

  for (const bIdx of boundaries) {
    const group = turns.slice(start, bIdx);
    if (group.length > 0) {
      subtopics.push({
        id: `subtopic-${subtopics.length}`,
        label: group[0].userPreview.slice(0, 40) || `Sub-topic ${subtopics.length + 1}`,
        turnSequences: group.map((t) => t.sequence),
        isCurrent: false,
      });
    }
    start = bIdx;
  }

  // 最后一组
  const lastGroup = turns.slice(start);
  if (lastGroup.length > 0) {
    subtopics.push({
      id: `subtopic-${subtopics.length}`,
      label: lastGroup[0].userPreview.slice(0, 40) || `Sub-topic ${subtopics.length + 1}`,
      turnSequences: lastGroup.map((t) => t.sequence),
      isCurrent: true,
    });
  }

  // 合并过短的子话题（< 2 turns）
  const merged = mergeShortSubTopics(subtopics, 2);

  return {
    topicId,
    subtopics: merged,
    method: "heuristic",
    createdAt: new Date().toISOString(),
  };
}

/**
 * 合并过短的子话题到相邻的子话题。
 */
function mergeShortSubTopics(subtopics: SubTopic[], minTurns: number): SubTopic[] {
  if (subtopics.length <= 1) return subtopics;

  let result = [...subtopics];
  let changed = true;

  while (changed) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      if (result[i].turnSequences.length < minTurns && result.length > 1) {
        // 合并到相邻的更大的子话题
        let mergeIdx: number;
        if (i === 0) {
          mergeIdx = 1;
        } else if (i === result.length - 1) {
          mergeIdx = i - 1;
        } else {
          const prevSize = result[i - 1].turnSequences.length;
          const nextSize = result[i + 1].turnSequences.length;
          mergeIdx = prevSize >= nextSize ? i - 1 : i + 1;
        }

        const a = result[Math.min(i, mergeIdx)];
        const b = result[Math.max(i, mergeIdx)];

        const merged: SubTopic = {
          id: a.id,
          label: a.label,
          turnSequences: [...a.turnSequences, ...b.turnSequences].sort((x, y) => x - y),
          isCurrent: a.isCurrent || b.isCurrent,
        };

        const newResult: SubTopic[] = [];
        const mergeMin = Math.min(i, mergeIdx);
        const mergeMax = Math.max(i, mergeIdx);
        for (let j = 0; j < result.length; j++) {
          if (j === mergeMin) newResult.push(merged);
          else if (j !== mergeMax) newResult.push(result[j]);
        }

        result = newResult;
        changed = true;
        break;
      }
    }
  }

  // 确保最后一个标记为 current
  if (result.length > 0) {
    result = result.map((s, i) => ({
      ...s,
      isCurrent: i === result.length - 1,
    }));
  }

  return result;
}
