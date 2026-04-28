/**
 * Embedding Detector — TF-IDF based topic boundary detection
 *
 * 第一层话题边界检测：基于 TF-IDF 关键词向量的余弦相似度。
 *
 * 不依赖任何外部 embedding 模型。纯本地计算，速度快。
 *
 * 算法流程：
 *   1. 从每个 Turn 提取文本（userPreview + assistantPreview + toolsUsed）
 *   2. 分词（支持中文字符级切分 + 英文词切分）
 *   3. 构建 TF-IDF 向量（全局 IDF 基于所有 Turn 的词频）
 *   4. 计算相邻 Turn 之间的余弦相似度
 *   5. 相似度低于阈值 → 标记为疑似话题边界
 */

import type { TurnIndex } from "../session-index/types.js";
import type { TopicBoundary, TopicSegmenterConfig } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
//  中文停用词（常见虚词，无语义价值）
// ═══════════════════════════════════════════════════════════════════════════

const CHINESE_STOP_WORDS = new Set([
  "的", "了", "和", "是", "在", "我", "有", "他", "这", "中", "大", "来", "上", "为",
  "与", "个", "到", "说", "就", "也", "都", "会", "那", "很", "好", "么", "但",
  "以", "要", "可", "还", "出", "如", "而", "于", "其", "或", "无", "可以", "没有",
  "不", "不是", "一", "一个", "一些", "这个", "那个", "什么", "怎么", "为什么",
  "啊", "吧", "呢", "嗯", "哦", "哈", "嘛", "吗", "呀", "哇",
]);

const ENGLISH_STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "this", "that", "these", "those",
  "it", "its", "i", "you", "he", "she", "we", "they", "my", "your",
  "his", "her", "our", "their", "what", "how", "why", "when", "where",
  "which", "who", "not", "no", "so", "if", "as", "up", "out", "about",
]);

// ═══════════════════════════════════════════════════════════════════════════
//  分词
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 对文本进行分词，同时支持中文和英文。
 *
 * 中文：按字符切分（每个 CJK 字符作为独立 token）
 * 英文：按空格和标点切分
 *
 * @param text 输入文本
 * @returns 词项列表（小写，已去除停用词）
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let currentWord = "";

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    // CJK 字符范围检测
    const isCJK =
      (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
      (code >= 0x20000 && code <= 0x2a6df) || // CJK Extension B
      (code >= 0xf900 && code <= 0xfaff);     // CJK Compat

    if (isCJK) {
      // 中文字符：先 flush 当前英文词，再直接加入
      if (currentWord.length > 0) {
        const w = currentWord.toLowerCase().trim();
        if (w.length > 1 && !ENGLISH_STOP_WORDS.has(w)) {
          tokens.push(w);
        }
        currentWord = "";
      }
      if (!CHINESE_STOP_WORDS.has(char)) {
        tokens.push(char);
      }
    } else if (/[a-zA-Z0-9_-]/.test(char)) {
      // 英文字母/数字：累积为词
      currentWord += char;
    } else {
      // 分隔符：flush 当前词
      if (currentWord.length > 0) {
        const w = currentWord.toLowerCase().trim();
        if (w.length > 1 && !ENGLISH_STOP_WORDS.has(w)) {
          tokens.push(w);
        }
        currentWord = "";
      }
    }
  }

  // flush 最后一个词
  if (currentWord.length > 0) {
    const w = currentWord.toLowerCase().trim();
    if (w.length > 1 && !ENGLISH_STOP_WORDS.has(w)) {
      tokens.push(w);
    }
  }

  return tokens;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Turn 文本提取
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 TurnIndex 提取用于 embedding 计算的文本。
 * 组合 userPreview + assistantPreview + toolsUsed。
 */
function extractTurnText(turn: TurnIndex): string {
  const parts: string[] = [];

  if (turn.userPreview) parts.push(turn.userPreview);
  if (turn.assistantPreview) parts.push(turn.assistantPreview);
  // 工具名也有语义价值（e.g., "exec", "read", "write" 代表不同类型的操作）
  if (turn.toolsUsed.length > 0) {
    parts.push(turn.toolsUsed.join(" "));
  }

  return parts.join(" ");
}

// ═══════════════════════════════════════════════════════════════════════════
//  TF-IDF 向量构建
// ═══════════════════════════════════════════════════════════════════════════

/** Turn 的词频向量 */
type TermFreqVector = Map<string, number>;

/**
 * 计算词频（TF）。
 * 使用归一化 TF：tf = count / total_terms（避免长文本偏差）。
 */
function computeTF(tokens: string[]): TermFreqVector {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }

  const total = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const [term, count] of counts) {
    tf.set(term, count / total);
  }
  return tf;
}

/**
 * 计算逆文档频率（IDF）。
 * idf = log(N / df + 1) + 1（平滑版本，避免 idf=0）
 *
 * @param allTokensList 所有 Turn 的 token 列表
 * @returns term → idf 值映射
 */
function computeIDF(allTokensList: string[][]): Map<string, number> {
  const N = allTokensList.length;
  const df = new Map<string, number>(); // term → 出现在多少个 Turn 中

  for (const tokens of allTokensList) {
    const seen = new Set(tokens);
    for (const term of seen) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(N / (count + 1)) + 1);
  }
  return idf;
}

/**
 * 构建 TF-IDF 向量。
 *
 * @param tf TF 向量
 * @param idf IDF 映射
 * @returns TF-IDF 向量（仅包含出现过的词）
 */
function buildTfIdfVector(
  tf: TermFreqVector,
  idf: Map<string, number>,
): Map<string, number> {
  const vec = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? 1;
    vec.set(term, tfVal * idfVal);
  }
  return vec;
}

// ═══════════════════════════════════════════════════════════════════════════
//  余弦相似度
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 计算两个稀疏向量的余弦相似度。
 *
 * @param a 向量 A
 * @param b 向量 B
 * @returns 余弦相似度 (0-1)，两个空向量返回 0
 */
function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  if (a.size === 0 || b.size === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  // 点积：只遍历较小的向量
  for (const [term, aVal] of a) {
    const bVal = b.get(term) ?? 0;
    dotProduct += aVal * bVal;
    normA += aVal * aVal;
  }

  for (const [, bVal] of b) {
    normB += bVal * bVal;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return Math.min(1, dotProduct / denom); // 钳制到 [0, 1]
}

// ═══════════════════════════════════════════════════════════════════════════
//  向量合并
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 合并多个 TF-IDF 向量为一个聚合向量（取平均值）。
 * 用于滑动窗口检测：将一组相邻 Turn 的向量合并后再比较。
 */
function mergeVectors(vectors: Map<string, number>[]): Map<string, number> {
  if (vectors.length === 0) return new Map();
  if (vectors.length === 1) return vectors[0];

  const merged = new Map<string, number>();
  for (const vec of vectors) {
    for (const [term, val] of vec) {
      merged.set(term, (merged.get(term) ?? 0) + val);
    }
  }

  // 取平均
  const count = vectors.length;
  for (const [term, val] of merged) {
    merged.set(term, val / count);
  }

  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════
//  主检测函数
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 基于 TF-IDF 向量余弦相似度检测话题边界。
 *
 * 使用滑动窗口策略：将边界前后各 windowSize 个 Turn 的向量聚合，
 * 计算前窗口与后窗口的相似度，而不是只看相邻两个 Turn。
 * 这样能避免短文本相似度天然偏低导致的误判。
 *
 * @param turns 所有 Turn 的索引列表（按 sequence 排序）
 * @param config TopicSegmenter 配置
 * @returns 检测到的话题边界列表
 */
export function detectBoundariesByEmbedding(
  turns: TurnIndex[],
  config: TopicSegmenterConfig,
): TopicBoundary[] {
  if (turns.length < 2) return [];

  const threshold = config.embeddingSimilarityThreshold;
  // 滑动窗口大小：边界前后各看多少个 Turn
  const windowSize = Math.max(1, Math.min(3, Math.floor(turns.length / 2)));

  // ── Step 1: 提取文本并分词 ──────────────────────────────────────
  const allTokensList: string[][] = turns.map((turn) =>
    tokenize(extractTurnText(turn)),
  );

  // ── Step 2: 构建全局 IDF ─────────────────────────────────────────
  const idf = computeIDF(allTokensList);

  // ── Step 3: 构建每个 Turn 的 TF-IDF 向量 ─────────────────────────
  const vectors: Map<string, number>[] = allTokensList.map((tokens) => {
    const tf = computeTF(tokens);
    return buildTfIdfVector(tf, idf);
  });

  // ── Step 4: 滑动窗口检测边界 ───────────────────────────────────
  const boundaries: TopicBoundary[] = [];

  for (let i = 1; i < turns.length; i++) {
    // 前窗口：[max(0, i-windowSize), i)
    const prevStart = Math.max(0, i - windowSize);
    const prevVec = mergeVectors(vectors.slice(prevStart, i));

    // 后窗口：[i, min(turns.length, i+windowSize))
    const nextEnd = Math.min(turns.length, i + windowSize);
    const nextVec = mergeVectors(vectors.slice(i, nextEnd));

    const similarity = cosineSimilarity(prevVec, nextVec);

    if (similarity < threshold) {
      // 相似度低 → 疑似话题切换
      const confidence = Math.min(1, 1 - similarity / threshold);

      boundaries.push({
        turnSequence: turns[i].sequence,
        method: "embedding",
        confidence,
      });
    }
  }

  return boundaries;
}

/**
 * 计算一个 Turn 与一组 Turn 的平均 TF-IDF 余弦相似度。
 *
 * 用于增量场景：判断新 Turn 是否属于当前话题。
 *
 * @param newTurn 新 Turn
 * @param referenceTurns 当前话题的参考 Turn（取最近几个）
 * @returns 平均余弦相似度 (0-1)
 */
export function computeTurnSimilarityToGroup(
  newTurn: TurnIndex,
  referenceTurns: TurnIndex[],
): number {
  if (referenceTurns.length === 0) return 1; // 没有参考，默认属于当前话题

  const allTurns = [...referenceTurns, newTurn];
  const allTokensList = allTurns.map((t) => tokenize(extractTurnText(t)));
  const idf = computeIDF(allTokensList);

  const newTokens = allTokensList[allTokensList.length - 1];
  const newVec = buildTfIdfVector(computeTF(newTokens), idf);

  let totalSim = 0;
  for (let i = 0; i < referenceTurns.length; i++) {
    const refVec = buildTfIdfVector(computeTF(allTokensList[i]), idf);
    totalSim += cosineSimilarity(newVec, refVec);
  }

  return totalSim / referenceTurns.length;
}
