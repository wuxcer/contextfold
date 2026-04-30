/**
 * Context Manager Plugin — Entry Point
 *
 * Registers agent tools for managing conversation context windows:
 * - context_stats: View current context statistics
 * - context_prune: Manually prune context to save tokens
 * - context_summarize: Summarize and compress old context
 * - context_pin: Pin important messages to prevent pruning
 * - context_config: View or update context manager config
 * - context_set_strategy: Switch pruning strategy
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { ContextManager } from "./context-manager.js";
import { formatTokenCount } from "./utils/index.js";
import {
  buildSessionIndex,
  SessionIndexQuery,
  saveIndex,
  loadIndex,
  isIndexStale,
  type SessionIndex,
  type TurnIndex,
} from "./session-index/index.js";
import { TurnIndexedContextEngine } from "./engine/index.js";
import { createContextEngineAdapter } from "./engine/adapter.js";
import type { SummarizeFn } from "./engine/context-engine.js";

// Per-session context manager instances
const managers = new Map<string, ContextManager>();

function getManager(
  sessionKey: string,
  pluginConfig: Record<string, unknown>,
): ContextManager {
  let mgr = managers.get(sessionKey);
  if (!mgr) {
    mgr = new ContextManager(pluginConfig);
    managers.set(sessionKey, mgr);
  }
  return mgr;
}

export default definePluginEntry({
  id: "context-manager",
  name: "Context Manager",
  description:
    "Manage, prune, summarize, and optimize conversation context windows",

  register(api) {
    const pluginConfig = api.pluginConfig ?? {};
    const runtime = (api as any).runtime;

    // ═══════════════════════════════════════════════════════════════════
    //  Register Context Engine
    // ═══════════════════════════════════════════════════════════════════

    // 构建 LLM 摘要函数（通过 subagent API 调用模型）
    let summarizeFn: SummarizeFn | undefined;

    if (runtime?.subagent) {
      summarizeFn = async (turnContent: string, context: string): Promise<string> => {
        const prompt = [
          "You are a conversation summarizer. Summarize the following conversation turn concisely.",
          "Focus on: what the user asked, what tools were used, what was the outcome.",
          "Keep it under 3 sentences. Do NOT include raw code or file contents.",
          "",
          `Context: ${context}`,
          "",
          turnContent,
        ].join("\n");

        const sessionKey = `context-manager-summarize-${Date.now()}`;
        const idempotencyKey = `contextfold-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const runResult = await runtime.subagent.run({
          sessionKey,
          idempotencyKey,
          message: prompt,
          ...(typeof pluginConfig.summaryModel === "string" ? { model: pluginConfig.summaryModel } : {}),
        });

        await runtime.subagent.waitForRun({ runId: runResult.runId, timeoutMs: 30_000 });

        const messages = await runtime.subagent.getSessionMessages({
          sessionKey,
          limit: 1,
        });

        // 清理临时 session
        try { await runtime.subagent.deleteSession({ sessionKey, deleteTranscript: true }); } catch {}

        const lastMsg = messages?.messages?.[0] as any;
        if (lastMsg?.role === "assistant") {
          const content = lastMsg.content;
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content.map((p: any) => p.text || "").join("");
          }
        }

        throw new Error("No assistant reply from summarization");
      };
      api.logger.info("Context Engine: LLM summarization enabled via subagent");
    } else {
      api.logger.info("Context Engine: using local extraction (no runtime.subagent available)");
    }

    // 注册 context engine
    api.registerContextEngine("turn-indexed", () =>
      createContextEngineAdapter({
        config: {
          preserveRecentTurns:
            typeof pluginConfig.preserveRecentMessages === "number"
              ? pluginConfig.preserveRecentMessages
              : undefined,
          maxContextTokens:
            typeof pluginConfig.maxTokens === "number"
              ? pluginConfig.maxTokens
              : undefined,
        },
        summarize: summarizeFn,
        logger: api.logger,
      }),
    );

    api.logger.info("Context Engine 'turn-indexed' registered");

    // ── Tool: context_engine_topics ───────────────────────────────
    api.registerTool({
      name: "context_engine_topics",
      label: "Context Engine Topics",
      description:
        "Show detected topic segments and sub-topics in the current session.",
      parameters: Type.Object({
        sessionFile: Type.Optional(
          Type.String({ description: "Path to session JSONL file" }),
        ),
      }),
      async execute(_id, params) {
        if (!params.sessionFile) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: "⚠️ sessionFile is required to show topic segments." },
            ],
          };
        }

        try {
          const { query } = await getOrBuildIndex(params.sessionFile);
          const allTopics = query.getAllTopics ? query.getAllTopics() : [];
          const turns = query.getAllTurns();

          if (allTopics.length === 0) {
            return {
              details: {},
              content: [
                { type: "text" as const, text: "ℹ️ No topics detected yet. The session may be too short or all turns belong to the same topic." },
              ],
            };
          }

          const turnsMap = new Map(turns.map((t) => [t.id, t]));

          // 加载子话题缓存
          const { loadSubTopicCache: loadSTCache } = await import("./topic/subtopic-cache.js");
          const subtopicCache = await loadSTCache(params.sessionFile);

          const lines: string[] = [
            `🎨 Topic Segments (话题分段)`,
            `├─ Total topics: ${allTopics.length}`,
            `├─ Total turns: ${turns.length}`,
            `└─ Topic-aware compression: enabled`,
            ``,
          ];

          for (let i = 0; i < allTopics.length; i++) {
            const topic = allTopics[i];
            const isLast = i === allTopics.length - 1;
            const prefix = isLast ? "🟢" : "⚪";
            const currentTag = isLast ? " [当前话题]" : "";

            lines.push(
              `${prefix} Topic ${i + 1}: ${topic.label}${currentTag}`,
              `   ├─ ID: ${topic.id}`,
              `   ├─ Turns: ${topic.turnIds.length}`,
              `   ├─ Tokens: ~${formatTokenCount(topic.totalTokens)}`,
              `   ├─ Time: ${topic.startTime} → ${topic.endTime}`,
              `   ├─ Status: ${topic.status}`,
            );

            // 显示子话题
            const stResult = subtopicCache.entries[topic.id];
            if (stResult && stResult.subtopics.length > 1) {
              lines.push(`   ├─ Sub-topics: ${stResult.subtopics.length} (${stResult.method})`);
              for (let j = 0; j < stResult.subtopics.length; j++) {
                const sub = stResult.subtopics[j];
                const subPrefix = sub.isCurrent ? "🟡" : "▫";
                const subTag = sub.isCurrent ? " [current]" : "";
                lines.push(
                  `   │  ${subPrefix} ${sub.label}${subTag} (${sub.turnSequences.length} turns: #${sub.turnSequences[0]}–#${sub.turnSequences[sub.turnSequences.length - 1]})`,
                );
              }
            }

            // 显示该 topic 下的 turn 概览（最多 5 个）
            const topicTurns = topic.turnIds
              .map((id) => turnsMap.get(id))
              .filter((t): t is NonNullable<typeof t> => t !== undefined);

            const preview = topicTurns.slice(0, 5);
            lines.push(`   └─ Turns:`);
            for (const t of preview) {
              lines.push(
                `      #${t.sequence} [${t.id.slice(0, 8)}...] ${t.userPreview.slice(0, 50)}`,
              );
            }
            if (topicTurns.length > 5) {
              lines.push(`      ... and ${topicTurns.length - 5} more`);
            }
            lines.push(``);
          }

          return {
            details: {},
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        } catch (err) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: `❌ Error: ${err}` },
            ],
          };
        }
      },
    });

    // ── Tool: context_stats ──────────────────────────────
    api.registerTool({
      name: "context_stats",
      label: "Context Stats",
      description:
        "View current context window statistics including token usage, message counts, and pruning strategy",
      parameters: Type.Object({
        sessionKey: Type.Optional(
          Type.String({ description: "Session key (defaults to current)" }),
        ),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);
        const formatted = mgr.formatStats();
        return {
          details: {},
          content: [{ type: "text" as const, text: formatted }],
        };
      },
    });

    // ── Tool: context_prune ──────────────────────────────
    api.registerTool({
      name: "context_prune",
      label: "Context Prune",
      description:
        "Prune conversation context to fit within token budget. Removes oldest or lowest-scoring messages while preserving pinned and system messages.",
      parameters: Type.Object({
        targetTokens: Type.Optional(
          Type.Number({
            description:
              "Target token count (defaults to maxTokens from config)",
          }),
        ),
        strategy: Type.Optional(
          Type.String({
            description:
              'Pruning strategy: "fifo" (oldest first), "sliding-window" (keep recent), "importance" (score-based)',
          }),
        ),
        sessionKey: Type.Optional(
          Type.String({ description: "Session key (defaults to current)" }),
        ),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);

        if (params.strategy) {
          mgr.setStrategy(params.strategy);
        }

        const result = mgr.prune(params.targetTokens);

        const lines = [
          `✂️ Context Pruned`,
          `├─ Strategy: ${mgr.getStrategyName()}`,
          `├─ Kept: ${result.kept.length} messages`,
          `├─ Pruned: ${result.pruned.length} messages`,
          `└─ Tokens saved: ${formatTokenCount(result.tokensSaved)}`,
        ];

        return {
          details: {},
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: context_summarize ──────────────────────────
    api.registerTool({
      name: "context_summarize",
      label: "Context Summarize",
      description:
        "Summarize and compress older context messages into a concise summary, freeing up token budget while preserving key information.",
      parameters: Type.Object({
        messageCount: Type.Optional(
          Type.Number({
            description:
              "Number of oldest messages to summarize (default: all prunable messages)",
          }),
        ),
        sessionKey: Type.Optional(
          Type.String({ description: "Session key (defaults to current)" }),
        ),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);

        const messages = mgr.getMessages();
        const count = params.messageCount ?? Math.max(0, messages.length - 10);
        const toSummarize = messages.slice(0, count);

        if (toSummarize.length === 0) {
          return {
            details: {},
            content: [
              {
                type: "text" as const,
                text: "ℹ️ No messages to summarize.",
              },
            ],
          };
        }

        const summary = mgr.createLocalSummary(toSummarize);

        const lines = [
          `📝 Context Summarized`,
          `├─ Original messages: ${summary.originalMessageCount}`,
          `├─ Original tokens: ${formatTokenCount(summary.originalTokenCount)}`,
          `├─ Summary tokens: ${formatTokenCount(summary.tokenCount)}`,
          `├─ Compression ratio: ${((1 - summary.tokenCount / summary.originalTokenCount) * 100).toFixed(1)}%`,
          `└─ Summary preview:`,
          summary.content.slice(0, 500),
        ];

        return {
          details: {},
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: context_pin ────────────────────────────────
    api.registerTool({
      name: "context_pin",
      label: "Context Pin",
      description:
        "Pin or unpin a message by index to prevent/allow it being pruned",
      parameters: Type.Object({
        index: Type.Number({
          description: "Message index (0-based)",
        }),
        pin: Type.Optional(
          Type.Boolean({
            description: "true to pin, false to unpin (default: true)",
          }),
        ),
        sessionKey: Type.Optional(
          Type.String({ description: "Session key (defaults to current)" }),
        ),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);
        const shouldPin = params.pin !== false;

        const success = shouldPin
          ? mgr.pinMessage(params.index)
          : mgr.unpinMessage(params.index);

        if (!success) {
          return {
            details: {},
            content: [
              {
                type: "text" as const,
                text: `❌ Invalid message index: ${params.index}`,
              },
            ],
          };
        }

        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `📌 Message ${params.index} ${shouldPin ? "pinned" : "unpinned"}.`,
            },
          ],
        };
      },
    });

    // ── Tool: context_config ─────────────────────────────
    api.registerTool({
      name: "context_config",
      label: "Context Config",
      description: "View or update context manager configuration",
      parameters: Type.Object({
        maxTokens: Type.Optional(Type.Number()),
        autoSummarize: Type.Optional(Type.Boolean()),
        summarizeThreshold: Type.Optional(Type.Number()),
        preserveRecentMessages: Type.Optional(Type.Number()),
        sessionKey: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);

        // Apply updates if any provided
        const updates: Record<string, unknown> = {};
        if (params.maxTokens !== undefined)
          updates.maxTokens = params.maxTokens;
        if (params.autoSummarize !== undefined)
          updates.autoSummarize = params.autoSummarize;
        if (params.summarizeThreshold !== undefined)
          updates.summarizeThreshold = params.summarizeThreshold;
        if (params.preserveRecentMessages !== undefined)
          updates.preserveRecentMessages = params.preserveRecentMessages;

        if (Object.keys(updates).length > 0) {
          mgr.updateConfig(updates as any);
        }

        const config = mgr.getConfig();
        const lines = [
          `⚙️ Context Manager Config`,
          `├─ maxTokens: ${formatTokenCount(config.maxTokens)}`,
          `├─ autoSummarize: ${config.autoSummarize}`,
          `├─ summarizeThreshold: ${(config.summarizeThreshold * 100).toFixed(0)}%`,
          `├─ preserveSystemMessages: ${config.preserveSystemMessages}`,
          `├─ preserveRecentMessages: ${config.preserveRecentMessages}`,
          `└─ summaryModel: ${config.summaryModel ?? "(current model)"}`,
        ];

        return {
          details: {},
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: context_set_strategy ───────────────────────
    api.registerTool({
      name: "context_set_strategy",
      label: "Context Set Strategy",
      description:
        'Set the pruning strategy: "fifo" (oldest first), "sliding-window" (keep recent), "importance" (score-based)',
      parameters: Type.Object({
        strategy: Type.String({
          description: 'Strategy name: "fifo", "sliding-window", or "importance"',
        }),
        sessionKey: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        const key = params.sessionKey ?? "default";
        const mgr = getManager(key, pluginConfig);
        mgr.setStrategy(params.strategy);

        return {
          details: {},
          content: [
            {
              type: "text" as const,
              text: `🔄 Pruning strategy set to: ${mgr.getStrategyName()}`,
            },
          ],
        };
      },
    });

    // ═══════════════════════════════════════════════════════════════════
    //  Session Index Tools
    // ═══════════════════════════════════════════════════════════════════

    // Per-session index cache
    const indexCache = new Map<string, { index: SessionIndex; query: SessionIndexQuery }>();

    async function getOrBuildIndex(sessionFile: string): Promise<{ index: SessionIndex; query: SessionIndexQuery }> {
      const cached = indexCache.get(sessionFile);
      if (cached) {
        const stale = await isIndexStale(sessionFile, cached.index);
        if (!stale) return cached;
      }

      // Try loading from disk first
      let index = await loadIndex(sessionFile);
      if (index) {
        const stale = await isIndexStale(sessionFile, index);
        if (stale) {
          // Incremental update
          index = await buildSessionIndex(sessionFile, index);
          await saveIndex(sessionFile, index);
        }
      } else {
        // Full build
        index = await buildSessionIndex(sessionFile);
        await saveIndex(sessionFile, index);
      }

      const entry = { index, query: new SessionIndexQuery(index) };
      indexCache.set(sessionFile, entry);
      return entry;
    }

    // ── Tool: session_index_build ─────────────────────────────────────
    api.registerTool({
      name: "session_index_build",
      label: "Session Index Build",
      description:
        "Build or refresh a session index from a session JSONL file. Returns index overview and turn list.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
      }),
      async execute(_id, params) {
        const { query } = await getOrBuildIndex(params.sessionFile);
        const text = query.formatOverview() + "\n\n" + query.formatTurnList();
        return {
          details: {},
          content: [{ type: "text" as const, text }],
        };
      },
    });

    // ── Tool: session_index_query ─────────────────────────────────────
    api.registerTool({
      name: "session_index_query",
      label: "Session Index Query",
      description:
        "Query a session index: list turns, get stats, find largest turns, identify compression candidates, or get turn details.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
        action: Type.Union([
          Type.Literal("stats"),
          Type.Literal("turns"),
          Type.Literal("recent_turns"),
          Type.Literal("largest_turns"),
          Type.Literal("tool_usage"),
          Type.Literal("compression_candidates"),
          Type.Literal("turn_detail"),
        ], {
          description: "Query action to perform",
        }),
        count: Type.Optional(
          Type.Number({ description: "Number of results (default: 10)" }),
        ),
        turnId: Type.Optional(
          Type.String({ description: "Turn ID for turn_detail action" }),
        ),
        targetTokens: Type.Optional(
          Type.Number({
            description: "Target token count for compression_candidates",
          }),
        ),
      }),
      async execute(_id, params) {
        const { query } = await getOrBuildIndex(params.sessionFile);
        const count = params.count ?? 10;
        let text = "";

        switch (params.action) {
          case "stats": {
            text = query.formatOverview();
            break;
          }
          case "turns": {
            text = query.formatTurnList();
            break;
          }
          case "recent_turns": {
            const turns = query.getRecentTurns(count);
            text = turns
              .map(
                (t) =>
                  `#${t.sequence} [${t.id}] lines ${t.lineStart}-${t.lineEnd} | ${formatTokenCount(t.totalTokens)} tokens | tools:[${t.toolsUsed.join(",")}]\n  user: ${t.userPreview.slice(0, 100)}\n  asst: ${t.assistantPreview.slice(0, 100)}`,
              )
              .join("\n\n");
            break;
          }
          case "largest_turns": {
            const turns = query.getLargestTurns(count);
            text = turns
              .map(
                (t) =>
                  `#${t.sequence} [${t.id}] lines ${t.lineStart}-${t.lineEnd} | ${formatTokenCount(t.totalTokens)} tokens\n  user: ${t.userPreview.slice(0, 80)}`,
              )
              .join("\n");
            break;
          }
          case "tool_usage": {
            const stats = query.getStats();
            const sorted = Object.entries(stats.toolCallsByName).sort(
              ([, a], [, b]) => b - a,
            );
            text = sorted
              .map(([name, c]) => `${name}: ${c}x`)
              .join("\n");
            break;
          }
          case "compression_candidates": {
            const target = params.targetTokens ?? 100000;
            const rec = query.recommendCompression(target);
            if (rec.turnIds.length === 0) {
              text = `✅ Context within target (${formatTokenCount(target)}). No compression needed.`;
            } else {
              const candidateTurns = rec.turnIds
                .map((id) => query.getTurn(id))
                .filter((t): t is TurnIndex => t !== undefined);
              text = [
                `🗜️ Compression Recommendation`,
                `├─ Target: ${formatTokenCount(target)}`,
                `├─ Current: ${formatTokenCount(query.getStats().totalTokens)}`,
                `├─ Turns to compress: ${rec.turnIds.length}`,
                `├─ Estimated savings: ~${formatTokenCount(rec.estimatedSavings)}`,
                `└─ Candidates:`,
                ...candidateTurns.map(
                  (t) => `   #${t.sequence} lines ${t.lineStart}-${t.lineEnd} | ${formatTokenCount(t.totalTokens)}`,
                ),
              ].join("\n");
            }
            break;
          }
          case "turn_detail": {
            if (!params.turnId) {
              text = "❌ turnId is required for turn_detail action";
              break;
            }
            const turn = query.getTurn(params.turnId);
            if (!turn) {
              text = `❌ Turn not found: ${params.turnId}`;
              break;
            }
            text = [
              `Turn #${turn.sequence} [${turn.id}]`,
              `├─ Lines: ${turn.lineStart} - ${turn.lineEnd}`,
              `├─ Messages: ${turn.messageCount}`,
              `├─ Tokens: ${formatTokenCount(turn.totalTokens)}`,
              `├─ Tools: [${turn.toolsUsed.join(", ")}]`,
              `├─ Error: ${turn.hasError ? "yes ⚠️" : "no"}`,
              `├─ Time: ${turn.startTime} → ${turn.endTime}`,
              `├─ User: ${turn.userPreview}`,
              `└─ Assistant: ${turn.assistantPreview}`,
            ].join("\n");
            break;
          }
        }

        return {
          details: {},
          content: [{ type: "text" as const, text: text || "(no results)" }],
        };
      },
    });

    // ── Tool: session_index_read_raw ──────────────────────────────────
    api.registerTool({
      name: "session_index_read_raw",
      label: "Session Index Read Raw",
      description:
        "Read original raw JSONL lines for a Turn by its ID. Use to recover full message content after context compression.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
        turnId: Type.String({
          description: "Turn ID to read raw lines for",
        }),
      }),
      async execute(_id, params) {
        const { query } = await getOrBuildIndex(params.sessionFile);
        try {
          const rawLines = await query.readTurnRaw(params.turnId);
          if (rawLines.length === 0) {
            return {
              details: {},
              content: [{ type: "text" as const, text: `❌ Turn not found: ${params.turnId}` }],
            };
          }
          const range = query.getTurnLineRange(params.turnId)!;
          const header = `Turn ${params.turnId} — lines ${range.lineStart}-${range.lineEnd}\n${"-".repeat(60)}`;
          const body = rawLines
            .map((line, i) => `[line ${range.lineStart + i}] ${line}`)
            .join("\n");
          return {
            details: {},
            content: [{ type: "text" as const, text: `${header}\n${body}` }],
          };
        } catch (err) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: `❌ Error: ${err}` },
            ],
          };
        }
      },
    });

    // ═══════════════════════════════════════════════════════════════════
    //  Context Engine Tools
    // ═══════════════════════════════════════════════════════════════════

    const engine = new TurnIndexedContextEngine({
      preserveRecentTurns:
        typeof pluginConfig.preserveRecentMessages === "number"
          ? pluginConfig.preserveRecentMessages
          : undefined,
      maxContextTokens:
        typeof pluginConfig.maxTokens === "number"
          ? pluginConfig.maxTokens
          : undefined,
    });

    // ── Tool: context_engine_status ───────────────────────────────────
    api.registerTool({
      name: "context_engine_status",
      label: "Context Engine Status",
      description:
        "Show the status of the Turn-indexed context engine: how many turns are compacted, tokens saved, current config.",
      parameters: Type.Object({
        sessionFile: Type.Optional(
          Type.String({ description: "Path to session JSONL file" }),
        ),
      }),
      async execute(_id, params) {
        const compStats = engine.getCompactionStats();
        const config = engine.getConfig();
        const lines = [
          `🧠 Context Engine Status`,
          `├─ Strategy: Turn-indexed (assemble + compact)`,
          `├─ Preserve recent: ${config.preserveRecentTurns} turns`,
          `├─ Max context: ${formatTokenCount(config.maxContextTokens)}`,
          `├─ Compaction threshold: ${(config.compactionThreshold * 100).toFixed(0)}%`,
          `├─ Compacted turns: ${compStats.totalCompacted}`,
          `├─ Tokens saved: ~${formatTokenCount(compStats.totalSaved)}`,
          `└─ Last compacted: ${compStats.lastCompactedAt ?? "never"}`,
        ];

        if (params.sessionFile) {
          try {
            const { query } = await engine.getIndex(params.sessionFile);
            const stats = query.getStats();
            const needsCompaction = await engine.needsCompaction(params.sessionFile);
            lines.push(
              ``,
              `📑 Session: ${query.getMeta().sessionId.slice(0, 8)}...`,
              `├─ Turns: ${stats.totalTurns}`,
              `├─ Tokens: ~${formatTokenCount(stats.totalTokens)}`,
              `└─ Needs compaction: ${needsCompaction ? "yes ⚠️" : "no ✅"}`,
            );
          } catch {
            lines.push(``, `⚠️ Could not read session file`);
          }
        }

        return {
          details: {},
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: context_engine_compact ──────────────────────────────────
    api.registerTool({
      name: "context_engine_compact",
      label: "Context Engine Compact",
      description:
        "Run compaction on a session: generate summaries for old turns while preserving originals in the session file. Recoverable via turn ID.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
      }),
      async execute(_id, params) {
        const result = await engine.compact(params.sessionFile);
        if (result.compactedCount === 0) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: "✅ Nothing to compact — all turns are recent or already compacted." },
            ],
          };
        }
        const text = [
          `🗜️ Compaction Complete`,
          `├─ Turns compacted: ${result.compactedCount}`,
          `├─ Tokens saved: ~${formatTokenCount(result.tokensSaved)}`,
          `├─ LLM calls: ${result.llmCalls}`,
          `├─ Cache hits: ${result.cacheHits}`,
          `└─ Method: ${result.llmCalls > 0 ? "LLM + cache" : "local extraction"}`,
          ``,
          `Summaries cached to disk — future compacts won’t re-call LLM.`,
          `Use session_index_read_raw to recover any turn by ID.`,
        ].join("\n");
        return {
          details: {},
          content: [{ type: "text" as const, text }],
        };
      },
    });

    // ── Tool: context_engine_recover ──────────────────────────────────
    api.registerTool({
      name: "context_engine_recover",
      label: "Context Engine Recover",
      description:
        "Recover the full original messages of a compacted turn by its ID. Use when you need detailed context that was lost during compaction.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
        turnId: Type.String({
          description: "Turn ID to recover (= user message entryId)",
        }),
      }),
      async execute(_id, params) {
        const recovered = await engine.recoverTurn(
          params.sessionFile,
          params.turnId,
        );
        if (!recovered) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: `❌ Turn not found: ${params.turnId}` },
            ],
          };
        }
        const text = [
          `🔄 Recovered Turn ${params.turnId}`,
          `├─ Lines: ${recovered.lineRange.lineStart}-${recovered.lineRange.lineEnd}`,
          `└─ Messages: ${recovered.messages.length}`,
          ``,
          ...recovered.messages.map((m, i) => {
            const msg = m.message as Record<string, unknown> | undefined;
            const role = msg?.role ?? "?";
            return `[${i + 1}] ${role}: ${JSON.stringify(msg?.content ?? "").slice(0, 300)}`;
          }),
        ].join("\n");
        return {
          details: {},
          content: [{ type: "text" as const, text }],
        };
      },
    });

    // ── Tool: context_engine_assemble ─────────────────────────────────
    api.registerTool({
      name: "context_engine_assemble",
      label: "Context Engine Assemble",
      description:
        "Preview what the context engine would send to the model: which turns are kept in full, which are summarized, and the total token count.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
      }),
      async execute(_id, params) {
        const { query } = await engine.getIndex(params.sessionFile);
        const turns = query.getAllTurns();
        const preserveCount = engine.getConfig().preserveRecentTurns;
        const cutoff = Math.max(0, turns.length - preserveCount);
        const compStats = engine.getCompactionStats();

        const lines = [
          `🔧 Assemble Preview`,
          `├─ Total turns: ${turns.length}`,
          `├─ Summarized: ${cutoff} (turns #0-#${cutoff - 1})`,
          `├─ Full context: ${turns.length - cutoff} (turns #${cutoff}-#${turns.length - 1})`,
          ``,
        ];

        // Summarized turns
        if (cutoff > 0) {
          lines.push(`📋 Summarized turns:`);
          for (let i = 0; i < cutoff; i++) {
            const t = turns[i];
            const state = compStats.totalCompacted > 0 ? "compacted" : "pending";
            lines.push(
              `  #${t.sequence} [${t.id}] ${state} | ${formatTokenCount(t.totalTokens)} → user: ${t.userPreview.slice(0, 60)}`,
            );
          }
          lines.push(``);
        }

        // Full turns
        lines.push(`💬 Full context turns:`);
        for (let i = cutoff; i < turns.length; i++) {
          const t = turns[i];
          lines.push(
            `  #${t.sequence} [${t.id}] lines ${t.lineStart}-${t.lineEnd} | ${formatTokenCount(t.totalTokens)} | user: ${t.userPreview.slice(0, 60)}`,
          );
        }

        return {
          details: {},
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    });

    // ── Tool: context_engine_detect_subtopics ───────────────────
    api.registerTool({
      name: "context_engine_detect_subtopics",
      label: "Detect Sub-topics",
      description:
        "Run sub-topic detection on a session. Splits major topics into finer-grained sub-topics for smarter compression.",
      parameters: Type.Object({
        sessionFile: Type.String({
          description: "Path to the session JSONL file",
        }),
      }),
      async execute(_id, params) {
        try {
          const { detectSubTopicsByLlm, detectSubTopicsByHeuristic } = await import("./topic/subtopic-detector.js");
          const { loadSubTopicCache: loadSTCache, saveSubTopicCache: saveSTCache } = await import("./topic/subtopic-cache.js");
          
          const { query } = await getOrBuildIndex(params.sessionFile);
          const allTopics = query.getAllTopics ? query.getAllTopics() : [];
          const turns = query.getAllTurns();
          const cache = await loadSTCache(params.sessionFile);
          let detected = 0;
          let totalSubtopics = 0;

          const lines: string[] = [
            `🔍 Sub-topic Detection Results`,
            ``,
          ];

          for (const topic of allTopics) {
            const topicTurns = topic.turnIds
              .map((id) => turns.find((t) => t.id === id))
              .filter((t): t is NonNullable<typeof t> => t !== undefined);

            if (topicTurns.length < 3) {
              lines.push(`⚪ Topic "${topic.label.slice(0, 40)}" — too few turns (${topicTurns.length}), skipped`);
              continue;
            }

            // 优先用 LLM（通过 engine 的 summarize 函数），回退到启发式
            let result;
            if (summarizeFn) {
              api.logger.info(`[detect_subtopics] topic=${topic.id}: using LLM mode`);
              result = await detectSubTopicsByLlm(topic.id, topicTurns, summarizeFn, api.logger);
            } else {
              api.logger.info(`[detect_subtopics] topic=${topic.id}: no summarizeFn, using heuristic`);
              result = detectSubTopicsByHeuristic(topic.id, topicTurns);
            }
            cache.entries[topic.id] = result;
            detected++;
            totalSubtopics += result.subtopics.length;

            lines.push(`📌 Topic "${topic.label.slice(0, 40)}" → ${result.subtopics.length} sub-topics (${result.method})`);
            for (const sub of result.subtopics) {
              const tag = sub.isCurrent ? "🟡 [current]" : "▫";
              lines.push(`   ${tag} "${sub.label.slice(0, 50)}" — turns [${sub.turnSequences.join(", ")}]`);
            }
            lines.push(``);
          }

          await saveSTCache(params.sessionFile, cache);

          lines.unshift(
            `🔍 Sub-topic Detection Results`,
            `├─ Topics processed: ${detected}`,
            `├─ Total sub-topics: ${totalSubtopics}`,
            `└─ Cache saved to disk`,
            ``,
          );
          // Remove the duplicate header
          lines.splice(2, 2);

          return {
            details: {},
            content: [{ type: "text" as const, text: lines.join("\n") }],
          };
        } catch (err) {
          return {
            details: {},
            content: [
              { type: "text" as const, text: `❌ Sub-topic detection failed: ${(err as Error).message}` },
            ],
          };
        }
      },
    });

    api.logger.info("Context Manager plugin registered successfully");
  },
});
