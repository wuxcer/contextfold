# Changelog — ContextFold

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
