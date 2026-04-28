/**
 * Topic Segmentation — Public API
 *
 * 话题分段模块的公开接口导出。
 */

export { TopicSegmenter } from "./topic-segmenter.js";
export type {
  TopicBoundary,
  TopicSegment,
  TopicSegmenterConfig,
} from "./types.js";
export { DEFAULT_TOPIC_SEGMENTER_CONFIG } from "./types.js";
export { detectBoundariesByEmbedding, computeTurnSimilarityToGroup } from "./embedding-detector.js";
export { confirmBoundariesByLlm, generateTopicLabel } from "./llm-classifier.js";
export {
  detectSubTopicsByLlm,
  detectSubTopicsByHeuristic,
  type SubTopic,
  type SubTopicResult,
  type LlmClassifyFn,
} from "./subtopic-detector.js";
