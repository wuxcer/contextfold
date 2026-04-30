/**
 * Context Engine Adapter
 *
 * 把 TurnIndexedContextEngine 适配为 OpenClaw SDK 要求的 ContextEngine 接口。
 * 通过 api.registerContextEngine() 注册后，OpenClaw 运行时会在
 * ingest → assemble → compact 生命周期中调用这些方法。
 */

import { TurnIndexedContextEngine, type EngineConfig, type SummarizeFn } from "./context-engine.js";
import { buildSessionIndex } from "../session-index/builder.js";
import { loadIndex, saveIndex } from "../session-index/persistence.js";
import { loadSummaryCache, getCacheStats } from "./summary-cache.js";
import { loadToolResultCache, getToolResultCacheStats } from "./tool-result-cache.js";

// ═══════════════════════════════════════════════════════════════════════════
//  Adapter
// ═══════════════════════════════════════════════════════════════════════════

export interface AdapterOptions {
  /** Engine 配置 */
  config?: Partial<EngineConfig>;
  /** LLM 摘要函数（由 plugin register 阶段注入） */
  summarize?: SummarizeFn;
  /** 可选 logger */
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

export function createContextEngineAdapter(
  options: AdapterOptions = {},
) {
  const engine = new TurnIndexedContextEngine({
    ...options.config,
    summarize: options.summarize,
    logger: options.logger,
  });

  const sessionFiles = new Map<string, string>();

  return {
    get info() {
      return {
        id: "turn-indexed",
        name: "Turn-Indexed Context Engine",
        version: "1.0.0",
        ownsCompaction: true,
      };
    },

    async bootstrap(params: { sessionId: string; sessionKey?: string; sessionFile: string }) {
      const { sessionId, sessionFile } = params;
      sessionFiles.set(sessionId, sessionFile);

      let index = await loadIndex(sessionFile);
      if (!index) {
        index = await buildSessionIndex(sessionFile);
        await saveIndex(sessionFile, index);
      }

      return {
        bootstrapped: true,
        importedMessages: index.stats.totalMessages,
      };
    },

    async ingest(_params: { sessionId: string; sessionKey?: string; message: any; isHeartbeat?: boolean }) {
      return { ingested: true };
    },

    async assemble(params: { sessionId: string; sessionKey?: string; sessionFile?: string; messages: any[]; tokenBudget?: number; model?: string; prompt?: string }) {
      const file = params.sessionFile ?? sessionFiles.get(params.sessionId);
      if (!file) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      if (params.tokenBudget) {
        engine.updateConfig({ maxContextTokens: params.tokenBudget });
      }

      const result = await engine.assemble(file, params.messages);

      return {
        messages: result.messages as any[],
        estimatedTokens: result.tokenCount,
      };
    },

    async compact(params: { sessionId: string; sessionKey?: string; sessionFile: string; tokenBudget?: number; force?: boolean }) {
      const file = params.sessionFile ?? sessionFiles.get(params.sessionId);
      if (!file) {
        return {
          ok: true,
          compacted: false,
          reason: "No session file available",
        };
      }

      sessionFiles.set(params.sessionId, file);

      if (params.tokenBudget) {
        engine.updateConfig({ maxContextTokens: params.tokenBudget });
      }

      // 始终运行 compact（engine 内部跳过已压缩的 turn + 最近 N 个 turn，
      // 所以多跑没有副作用，但能更早触发 LLM 摘要和子话题检测）
      const result = await engine.compact(file);

      if (result.compactedCount === 0) {
        return {
          ok: true,
          compacted: false,
          reason: "All turns already compacted or recent",
        };
      }

      const cache = await loadSummaryCache(file);
      const cacheStats = getCacheStats(cache);
      const trCache = await loadToolResultCache(file);
      const trCacheStats = getToolResultCacheStats(trCache);

      return {
        ok: true,
        compacted: true,
        result: {
          summary: `Compacted ${result.compactedCount} turns (${result.llmCalls} LLM, ${result.cacheHits} cached)`,
          tokensBefore: cacheStats.totalTokensSaved + result.tokensSaved,
          tokensAfter: result.tokensSaved,
          details: {
            compactedCount: result.compactedCount,
            tokensSaved: result.tokensSaved,
            llmCalls: result.llmCalls,
            cacheHits: result.cacheHits,
            toolResultTruncations: trCacheStats.totalEntries,
            toolResultTokensSaved: trCacheStats.totalTokensSaved,
          },
        },
      };
    },

    async dispose() {
      sessionFiles.clear();
    },
  };
}
