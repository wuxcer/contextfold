# Changelog — ContextFold

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Phase 4: Content normalization** — `assemble()` now ensures all returned messages have `content` as `ContentPart[]` (array format) for OpenClaw Pi runtime compatibility
- **Ingest lifecycle hook** — adapter `ingest()` triggers async index rebuild and subtopic classification when an assistant message arrives (turn complete)
- **Tool result head+tail truncation** — large tool results automatically truncated to 40K chars and cached in `.toolresults.json` (zero LLM cost)
- **Selective LLM compaction** — only the top-N largest turns are compressed per async cycle (`maxCompactionsPerCycle`, default 3)
- **Per-turn subtopicId/subtopicLabel** — stored directly in `TurnIndex` for O(1) lookup during assemble, eliminating runtime subtopic cache reads

### Changed

- **Assemble rewrite** — Phase 1 now uses original messages with cached tool results instead of 200-char previews; produces higher-fidelity context within budget
- **Topic/subtopic drop strategy** — turns with a different topic or completed subtopic are dropped entirely in Phase 1 (previously only cross-topic turns were dropped)
- **Subtopic detection timing** — moved from post-compact to pre-assemble, then further to per-turn async via `onTurnComplete()` for lower latency
- **Lightweight LLM classification** — per-turn topic classification uses ~200 tokens (userPreview + assistantPreview + tool names only), runs asynchronously and never blocks

### Fixed

- `buildCompactInput` now uses cached truncated tool results instead of 200-char raw preview (was producing low-quality summaries for tool-heavy turns)
- Subtopic detection no longer runs during compact (was causing double-classification and stale cache issues)

---

## [1.0.0] - 2026-04-28

### Added

- **Turn-indexed context engine** — assemble/compact lifecycle integrated with OpenClaw runtime
  - `assemble()`: Composes optimized message list for model calls (summaries + full recent turns)
  - `compact()`: Generates LLM summaries for old turns, caches to disk
  - Full recovery of any compacted turn via `context_engine_recover`

- **Topic-aware compression**
  - Embedding-based coarse topic boundary detection (cosine similarity)
  - LLM-powered boundary confirmation with automatic label generation
  - Cross-topic turns compressed to one-line labels (~15 tokens each)
  - Same-topic old turns preserved as summaries

- **Sub-topic detection**
  - LLM-driven sub-task identification within major topics
  - Completed sub-topics compressed to one-line labels
  - Current sub-topic retains turn-level summaries
  - Heuristic fallback when LLM is unavailable
  - Disk-cached results to avoid redundant LLM calls

- **Session indexing**
  - Incremental JSONL parser with turn boundary detection
  - Token estimation per turn
  - Query API: stats, largest turns, compression candidates, topic listing
  - Persistent index with staleness detection

- **Agent tools** (18 tools registered)
  - Context management: `context_stats`, `context_prune`, `context_summarize`, `context_pin`, `context_config`, `context_set_strategy`
  - Context engine: `context_engine_status`, `context_engine_compact`, `context_engine_recover`, `context_engine_assemble`, `context_engine_topics`, `context_engine_detect_subtopics`
  - Session index: `session_index_build`, `session_index_query`, `session_index_read_raw`

- **Pruning strategies**: fifo, sliding-window, importance (score-based)

- **LLM summary caching** — summaries persisted to `.summary-cache.json`, sub-topics to `.subtopic-cache.json`

- **Graceful degradation** — all LLM features fall back to local heuristics when `runtime.subagent` is unavailable
