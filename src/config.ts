/**
 * Context Manager Plugin Configuration
 */
export interface ContextManagerConfig {
  /** Maximum token budget for context window */
  maxTokens: number;
  /** Model to use for context summarization */
  summaryModel?: string;
  /** Automatically summarize when context exceeds threshold */
  autoSummarize: boolean;
  /** Token percentage threshold to trigger auto-summarization (0-1) */
  summarizeThreshold: number;
  /** Always preserve system messages during pruning */
  preserveSystemMessages: boolean;
  /** Number of recent messages to always keep */
  preserveRecentMessages: number;
}

export const DEFAULT_CONFIG: ContextManagerConfig = {
  maxTokens: 128_000,
  autoSummarize: true,
  summarizeThreshold: 0.8,
  preserveSystemMessages: true,
  preserveRecentMessages: 10,
};

export function resolveConfig(
  pluginConfig: Record<string, unknown>,
): ContextManagerConfig {
  return {
    maxTokens:
      typeof pluginConfig.maxTokens === "number"
        ? pluginConfig.maxTokens
        : DEFAULT_CONFIG.maxTokens,
    summaryModel:
      typeof pluginConfig.summaryModel === "string"
        ? pluginConfig.summaryModel
        : undefined,
    autoSummarize:
      typeof pluginConfig.autoSummarize === "boolean"
        ? pluginConfig.autoSummarize
        : DEFAULT_CONFIG.autoSummarize,
    summarizeThreshold:
      typeof pluginConfig.summarizeThreshold === "number"
        ? pluginConfig.summarizeThreshold
        : DEFAULT_CONFIG.summarizeThreshold,
    preserveSystemMessages:
      typeof pluginConfig.preserveSystemMessages === "boolean"
        ? pluginConfig.preserveSystemMessages
        : DEFAULT_CONFIG.preserveSystemMessages,
    preserveRecentMessages:
      typeof pluginConfig.preserveRecentMessages === "number"
        ? pluginConfig.preserveRecentMessages
        : DEFAULT_CONFIG.preserveRecentMessages,
  };
}
