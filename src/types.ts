/**
 * Message and context types for the Context Manager
 */

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Approximate token count for this message */
  tokenCount?: number;
  /** Timestamp when the message was added */
  timestamp?: number;
  /** Unique message identifier */
  id?: string;
  /** Whether this message is pinned (should never be pruned) */
  pinned?: boolean;
  /** Metadata attached to the message */
  metadata?: Record<string, unknown>;
}

export interface ContextWindow {
  /** All messages in the current context */
  messages: ContextMessage[];
  /** Total estimated token count */
  totalTokens: number;
  /** Maximum allowed tokens */
  maxTokens: number;
  /** Usage ratio (0-1) */
  usage: number;
  /** Session key for this context */
  sessionKey?: string;
}

export interface ContextSummary {
  /** The summarized text */
  content: string;
  /** Number of original messages that were summarized */
  originalMessageCount: number;
  /** Approximate token count of the summary */
  tokenCount: number;
  /** Timestamp when the summary was generated */
  createdAt: number;
  /** Token count of the original messages */
  originalTokenCount: number;
}

export interface PruneResult {
  /** Messages that were kept */
  kept: ContextMessage[];
  /** Messages that were pruned */
  pruned: ContextMessage[];
  /** Summary generated from pruned messages (if applicable) */
  summary?: ContextSummary;
  /** Tokens saved by pruning */
  tokensSaved: number;
}

export interface ContextStats {
  /** Total messages in context */
  messageCount: number;
  /** Total estimated tokens */
  totalTokens: number;
  /** Max allowed tokens */
  maxTokens: number;
  /** Usage ratio (0-1) */
  usage: number;
  /** Messages by role */
  byRole: Record<string, number>;
  /** Number of pinned messages */
  pinnedCount: number;
  /** Number of summaries in context */
  summaryCount: number;
}
