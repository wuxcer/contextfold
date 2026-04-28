/**
 * Pruning strategies for context management.
 *
 * Each strategy determines how to select messages for removal
 * when the context window exceeds its token budget.
 */

import type { ContextMessage, PruneResult } from "../types.js";
import type { ContextManagerConfig } from "../config.js";
import { estimateTokens, totalTokens } from "../utils/index.js";

/**
 * Strategy interface — all pruning strategies implement this.
 */
export interface PruneStrategy {
  name: string;
  description: string;
  prune(
    messages: ContextMessage[],
    targetTokens: number,
    config: ContextManagerConfig,
  ): PruneResult;
}

/**
 * FIFO (First-In-First-Out) strategy.
 * Removes the oldest non-pinned, non-system messages first.
 */
export class FifoPruneStrategy implements PruneStrategy {
  name = "fifo";
  description = "Remove oldest messages first (preserving pinned and system messages)";

  prune(
    messages: ContextMessage[],
    targetTokens: number,
    config: ContextManagerConfig,
  ): PruneResult {
    const current = totalTokens(messages);
    if (current <= targetTokens) {
      return { kept: [...messages], pruned: [], tokensSaved: 0 };
    }

    const kept: ContextMessage[] = [];
    const pruned: ContextMessage[] = [];

    // Always keep the last N messages
    const recentBoundary = Math.max(0, messages.length - config.preserveRecentMessages);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const isProtected =
        msg.pinned ||
        (config.preserveSystemMessages && msg.role === "system") ||
        i >= recentBoundary;

      if (isProtected) {
        kept.push(msg);
      } else {
        // Check if we still need to prune
        const keptTokens = totalTokens(kept);
        const remainingTokens = totalTokens(messages.slice(i));
        if (keptTokens + remainingTokens <= targetTokens) {
          // No more pruning needed, keep the rest
          kept.push(...messages.slice(i));
          break;
        }
        pruned.push(msg);
      }
    }

    const tokensSaved = current - totalTokens(kept);
    return { kept, pruned, tokensSaved };
  }
}

/**
 * Sliding window strategy.
 * Keeps a fixed-size sliding window of the most recent messages.
 */
export class SlidingWindowStrategy implements PruneStrategy {
  name = "sliding-window";
  description = "Keep a sliding window of the most recent messages within token budget";

  prune(
    messages: ContextMessage[],
    targetTokens: number,
    config: ContextManagerConfig,
  ): PruneResult {
    const current = totalTokens(messages);
    if (current <= targetTokens) {
      return { kept: [...messages], pruned: [], tokensSaved: 0 };
    }

    // Collect system/pinned messages that are always kept
    const alwaysKept: Array<{ msg: ContextMessage; idx: number }> = [];
    const candidates: Array<{ msg: ContextMessage; idx: number }> = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.pinned || (config.preserveSystemMessages && msg.role === "system")) {
        alwaysKept.push({ msg, idx: i });
      } else {
        candidates.push({ msg, idx: i });
      }
    }

    // Calculate budget remaining after always-kept messages
    const alwaysKeptTokens = totalTokens(alwaysKept.map((e) => e.msg));
    let budget = targetTokens - alwaysKeptTokens;

    // Fill from the end (most recent first)
    const windowKept: Array<{ msg: ContextMessage; idx: number }> = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const entry = candidates[i];
      const tokens = entry.msg.tokenCount ?? estimateTokens(entry.msg.content);
      if (budget >= tokens) {
        windowKept.unshift(entry);
        budget -= tokens;
      }
    }

    // Merge and sort by original index
    const allKept = [...alwaysKept, ...windowKept].sort((a, b) => a.idx - b.idx);
    const keptSet = new Set(allKept.map((e) => e.idx));

    const kept = allKept.map((e) => e.msg);
    const pruned = messages.filter((_, i) => !keptSet.has(i));
    const tokensSaved = current - totalTokens(kept);

    return { kept, pruned, tokensSaved };
  }
}

/**
 * Importance-based strategy.
 * Scores messages by role, recency, and content length,
 * then prunes lowest-scoring messages first.
 */
export class ImportancePruneStrategy implements PruneStrategy {
  name = "importance";
  description = "Score messages by importance and prune lowest-scoring ones first";

  prune(
    messages: ContextMessage[],
    targetTokens: number,
    config: ContextManagerConfig,
  ): PruneResult {
    const current = totalTokens(messages);
    if (current <= targetTokens) {
      return { kept: [...messages], pruned: [], tokensSaved: 0 };
    }

    // Score each message
    const scored = messages.map((msg, idx) => ({
      msg,
      idx,
      score: this.scoreMessage(msg, idx, messages.length, config),
    }));

    // Sort by score ascending (lowest score = first to prune)
    const sortedByScore = [...scored].sort((a, b) => a.score - b.score);

    let tokensToSave = current - targetTokens;
    const prunedIndices = new Set<number>();

    for (const entry of sortedByScore) {
      if (tokensToSave <= 0) break;

      // Never prune pinned or protected messages
      if (
        entry.msg.pinned ||
        (config.preserveSystemMessages && entry.msg.role === "system") ||
        entry.idx >= messages.length - config.preserveRecentMessages
      ) {
        continue;
      }

      const tokens = entry.msg.tokenCount ?? estimateTokens(entry.msg.content);
      prunedIndices.add(entry.idx);
      tokensToSave -= tokens;
    }

    const kept = messages.filter((_, i) => !prunedIndices.has(i));
    const pruned = messages.filter((_, i) => prunedIndices.has(i));
    const tokensSaved = current - totalTokens(kept);

    return { kept, pruned, tokensSaved };
  }

  private scoreMessage(
    msg: ContextMessage,
    index: number,
    total: number,
    _config: ContextManagerConfig,
  ): number {
    let score = 0;

    // Role weight
    const roleWeights: Record<string, number> = {
      system: 100,
      user: 30,
      assistant: 20,
      tool: 10,
    };
    score += roleWeights[msg.role] ?? 15;

    // Recency bonus (newer = higher score)
    const recencyRatio = index / Math.max(1, total - 1);
    score += recencyRatio * 50;

    // Pinned bonus
    if (msg.pinned) score += 1000;

    return score;
  }
}

/**
 * Get a strategy by name.
 */
export function getStrategy(name: string): PruneStrategy {
  switch (name) {
    case "fifo":
      return new FifoPruneStrategy();
    case "sliding-window":
      return new SlidingWindowStrategy();
    case "importance":
      return new ImportancePruneStrategy();
    default:
      return new FifoPruneStrategy();
  }
}
