/**
 * Context Manager — core engine for managing conversation context windows.
 */

import type {
  ContextMessage,
  ContextWindow,
  ContextStats,
  ContextSummary,
  PruneResult,
} from "./types.js";
import type { ContextManagerConfig } from "./config.js";
import { DEFAULT_CONFIG, resolveConfig } from "./config.js";
import { estimateTokens, totalTokens, formatTokenCount } from "./utils/index.js";
import { getStrategy, type PruneStrategy } from "./strategies/index.js";

export class ContextManager {
  private messages: ContextMessage[] = [];
  private summaries: ContextSummary[] = [];
  private config: ContextManagerConfig;
  private strategy: PruneStrategy;

  constructor(
    pluginConfig: Record<string, unknown> = {},
    strategyName: string = "fifo",
  ) {
    this.config = resolveConfig(pluginConfig);
    this.strategy = getStrategy(strategyName);
  }

  // ── Message Management ─────────────────────────────────

  /** Add a message to the context. */
  addMessage(message: ContextMessage): void {
    if (!message.tokenCount) {
      message.tokenCount = estimateTokens(message.content);
    }
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }
    this.messages.push(message);
  }

  /** Add multiple messages at once. */
  addMessages(messages: ContextMessage[]): void {
    for (const msg of messages) {
      this.addMessage(msg);
    }
  }

  /** Get all messages in the current context. */
  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  /** Clear all messages. */
  clear(): void {
    this.messages = [];
    this.summaries = [];
  }

  /** Pin a message by index so it won't be pruned. */
  pinMessage(index: number): boolean {
    if (index >= 0 && index < this.messages.length) {
      this.messages[index].pinned = true;
      return true;
    }
    return false;
  }

  /** Unpin a message by index. */
  unpinMessage(index: number): boolean {
    if (index >= 0 && index < this.messages.length) {
      this.messages[index].pinned = false;
      return true;
    }
    return false;
  }

  // ── Context Window ─────────────────────────────────────

  /** Get the current context window snapshot. */
  getWindow(): ContextWindow {
    const total = totalTokens(this.messages);
    return {
      messages: [...this.messages],
      totalTokens: total,
      maxTokens: this.config.maxTokens,
      usage: total / this.config.maxTokens,
    };
  }

  /** Check if the context is approaching the token limit. */
  isNearLimit(): boolean {
    const usage = totalTokens(this.messages) / this.config.maxTokens;
    return usage >= this.config.summarizeThreshold;
  }

  /** Check if the context has exceeded the token limit. */
  isOverLimit(): boolean {
    return totalTokens(this.messages) > this.config.maxTokens;
  }

  // ── Pruning ────────────────────────────────────────────

  /** Prune the context to fit within the token budget. */
  prune(targetTokens?: number): PruneResult {
    const target = targetTokens ?? this.config.maxTokens;
    const result = this.strategy.prune(this.messages, target, this.config);
    this.messages = result.kept;
    return result;
  }

  /** Set the pruning strategy. */
  setStrategy(name: string): void {
    this.strategy = getStrategy(name);
  }

  /** Get current strategy name. */
  getStrategyName(): string {
    return this.strategy.name;
  }

  // ── Summarization ──────────────────────────────────────

  /**
   * Generate a summary from pruned messages.
   * This is a local (non-LLM) extractive summary.
   * For LLM-powered summaries, use the `context_summarize` tool.
   */
  createLocalSummary(messages: ContextMessage[]): ContextSummary {
    if (messages.length === 0) {
      return {
        content: "(empty context)",
        originalMessageCount: 0,
        tokenCount: 2,
        createdAt: Date.now(),
        originalTokenCount: 0,
      };
    }

    // Extract key points: take the first sentence of each user/assistant message
    const keyPoints: string[] = [];

    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        const firstSentence = msg.content.split(/[.!?。！？\n]/)[0]?.trim();
        if (firstSentence && firstSentence.length > 10) {
          keyPoints.push(`[${msg.role}] ${firstSentence}`);
        }
      }
    }

    const summaryContent =
      keyPoints.length > 0
        ? `Context summary (${messages.length} messages):\n${keyPoints.slice(0, 20).join("\n")}`
        : `Context summary: ${messages.length} messages exchanged.`;

    const summary: ContextSummary = {
      content: summaryContent,
      originalMessageCount: messages.length,
      tokenCount: estimateTokens(summaryContent),
      createdAt: Date.now(),
      originalTokenCount: totalTokens(messages),
    };

    this.summaries.push(summary);
    return summary;
  }

  /** Get all generated summaries. */
  getSummaries(): ContextSummary[] {
    return [...this.summaries];
  }

  // ── Stats ──────────────────────────────────────────────

  /** Get detailed statistics about the current context. */
  getStats(): ContextStats {
    const byRole: Record<string, number> = {};
    let pinnedCount = 0;

    for (const msg of this.messages) {
      byRole[msg.role] = (byRole[msg.role] ?? 0) + 1;
      if (msg.pinned) pinnedCount++;
    }

    const total = totalTokens(this.messages);

    return {
      messageCount: this.messages.length,
      totalTokens: total,
      maxTokens: this.config.maxTokens,
      usage: total / this.config.maxTokens,
      byRole,
      pinnedCount,
      summaryCount: this.summaries.length,
    };
  }

  /** Format stats as a human-readable string. */
  formatStats(): string {
    const stats = this.getStats();
    const usagePercent = (stats.usage * 100).toFixed(1);
    const lines = [
      `📊 Context Stats`,
      `├─ Messages: ${stats.messageCount}`,
      `├─ Tokens: ${formatTokenCount(stats.totalTokens)} / ${formatTokenCount(stats.maxTokens)} (${usagePercent}%)`,
      `├─ Strategy: ${this.strategy.name}`,
      `├─ Pinned: ${stats.pinnedCount}`,
      `├─ Summaries: ${stats.summaryCount}`,
      `└─ By role: ${Object.entries(stats.byRole)
        .map(([role, count]) => `${role}=${count}`)
        .join(", ")}`,
    ];
    return lines.join("\n");
  }

  // ── Configuration ──────────────────────────────────────

  /** Update configuration. */
  updateConfig(newConfig: Partial<ContextManagerConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /** Get current configuration. */
  getConfig(): ContextManagerConfig {
    return { ...this.config };
  }
}
