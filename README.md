# ContextFold

**Lossless context folding for [OpenClaw](https://github.com/openclaw/openclaw) agents.**

Detect topic boundaries → fold old conversations → keep what matters → unfold on demand.

[![npm](https://img.shields.io/npm/v/@openclaw/contextfold)](https://www.npmjs.com/package/@openclaw/contextfold)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

```
 30 turns · 50K tokens                    What the model sees
┌──────────────────────┐          ┌──────────────────────────────┐
│ ☁️  Weather (3 turns) │          │ [Weather — 3 turns, folded]  │  ~15 tokens
│ 🍜 Lunch (2 turns)   │   fold   │ [Lunch — 2 turns, folded]    │  ~15 tokens
│ 💻 Dev: architecture │  ─────▶  │ [Dev/arch — 5 turns, folded] │  ~15 tokens
│ 💻 Dev: coding       │          │ [Dev/coding — summary...]    │  ~200 tokens
│ 💻 Dev: debugging ←  │          │ Turn 28: (full)              │  original
│   (recent turns)     │          │ Turn 29: (full)              │  original
│                      │          │ Turn 30: (full)              │  original
└──────────────────────┘          └──────────────────────────────┘
         50K tokens                        ~2K tokens ✂️
```

**Nothing is deleted.** The original session transcript is append-only. Any folded turn can be unfolded (recovered) instantly.

---

## How It Works

### Four-Phase Compression Pipeline

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Every assemble() call:                                                  │
│                                                                          │
│  Phase 1 — Non-protected turns:                                          │
│    ① Topic filter: different topic/subtopic → DROP (0 cost)              │
│    ② Has LLM summary → use summary                                      │
│    ③ No summary → original messages (tool results from cache)            │
│                                                                          │
│  Phase 2 — Protected turns (recent 5):                                   │
│    └─ Original messages unchanged                                        │
│                                                                          │
│  Phase 3 — Pre-compaction check (every assemble):                        │
│    Over budget?                                                          │
│    ├─ Step 1: head+tail truncate large tool results → cache (0 cost)     │
│    └─ Step 2: still over? → async LLM compress top-3 largest turns       │
│                                                                          │
│  Phase 4 — Content normalization:                                        │
│    └─ Ensure all message content is ContentPart[] (array format)         │
│       Required by OpenClaw Pi runtime                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Level | Method | Cost | Effect |
|---|---|---|---|
| Drop irrelevant topics | topic/subtopic match | 0 | Entire turn removed |
| Tool result truncation | head+tail algorithm | 0 | Large results → 40K chars |
| LLM summarization | async, top-N largest | $$$ | Entire turn → ~50 tokens |
| Content normalization | string → ContentPart[] | 0 | Runtime compatibility |

### Two-Layer Topic Detection

**Layer 1: TF-IDF coarse segmentation** (at index build time, 0 cost)
— Cosine similarity between adjacent turns finds major topic shifts (weather → coding → dinner)
— Pure local computation, no API calls

**Layer 2: Per-turn lightweight LLM classification** (async, triggered via `ingest()` lifecycle)
— Triggered automatically when an assistant message is ingested (turn complete)
— Input: ~100-200 tokens (userPreview + assistantPreview + tool names only)
— Output: `{"subtopic": "<label>", "isNewSubtopic": bool}` (~30-50 tokens)
— Result stored in `TurnIndex.subtopicId` for direct O(1) lookup
— Never blocks assemble or compact

### Ingest Lifecycle

The adapter hooks into OpenClaw’s `ingest()` callback. When an assistant message arrives (signaling turn completion):

1. **Async index update** — incrementally rebuilds the session index
2. **Subtopic classification** — calls `onTurnComplete()` to classify the latest turn
3. **Non-blocking** — all work runs asynchronously without blocking message flow

### Folding Strategy

| Context | Treatment | Cost |
|---|---|---|
| Recent N turns (protected) | Kept in full | Original tokens |
| Same topic + same subtopic | Original or LLM summary | 0–10% |
| Same topic + different subtopic | Dropped entirely | 0 tokens |
| Different topic | Dropped entirely | 0 tokens |
| Large tool results (non-protected) | head+tail truncated | 0 cost, ~60% saved |

### Unfolding (Recovery)

Every turn has a stable ID mapped to line ranges in the session JSONL. Call `context_engine_recover(turnId)` and get back the complete original messages — tool calls, code, everything.

---

## Features

### Agent Tools

**Context Management**

| Tool | What it does |
|---|---|
| `context_stats` | Token usage, message counts, strategy |
| `context_prune` | Manual pruning (fifo / sliding-window / importance) |
| `context_summarize` | Compress old messages into a summary |
| `context_pin` | Pin messages to prevent pruning |
| `context_config` | View / update configuration |
| `context_set_strategy` | Switch pruning strategy |

**Context Engine (the core)**

| Tool | What it does |
|---|---|
| `context_engine_status` | Compaction stats, health check |
| `context_engine_compact` | Run folding — summarize old turns |
| `context_engine_recover` | Unfold — restore any turn's full messages |
| `context_engine_assemble` | Preview what the model will see |
| `context_engine_topics` | Show detected topics & sub-topics |
| `context_engine_detect_subtopics` | Manually trigger sub-topic detection |

**Session Index**

| Tool | What it does |
|---|---|
| `session_index_build` | Build / refresh index from session JSONL |
| `session_index_query` | Query: stats, largest turns, compression candidates |
| `session_index_read_raw` | Read original JSONL lines for any turn |

---

## Installation

### From source

```bash
git clone https://github.com/wuxcer/openclaw-contextfold.git
cd openclaw-contextfold
npm install
npm run build
```

Add to `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "context-manager": {
        "enabled": true,
        "config": {
          "maxTokens": 128000,
          "autoSummarize": true,
          "summarizeThreshold": 0.8,
          "preserveRecentMessages": 10
        }
      }
    },
    "allow": ["context-manager"],
    "load": {
      "paths": ["/path/to/openclaw-contextfold"]
    }
  }
}
```

### From npm (when published)

```bash
openclaw plugins install @openclaw/contextfold
```

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `maxTokens` | number | `128000` | Context window token budget |
| `summaryModel` | string | *(current model)* | Model for generating summaries |
| `autoSummarize` | boolean | `true` | Auto-fold when context exceeds threshold |
| `summarizeThreshold` | number | `0.8` | Usage ratio (0–1) to trigger folding |
| `preserveSystemMessages` | boolean | `true` | Keep system messages during pruning |
| `preserveRecentMessages` | number | `5` | Turns to always keep in full |

### Topic Detection Internals

| Parameter | Default | Description |
|---|---|---|
| `embeddingSimilarityThreshold` | `0.05` | Cosine similarity cutoff for topic boundaries |
| `minTurnsPerTopic` | `2` | Minimum turns for a standalone topic |
| `enableLlmConfirmation` | `true` | LLM-confirm embedding-detected boundaries |
| `toolResultTruncateChars` | `40000` | Max chars before head+tail truncation kicks in |
| `maxCompactionsPerCycle` | `3` | Max turns to LLM-compress per async cycle |

---

## Architecture

```
src/
├── index.ts                          # Plugin entry — tool & engine registration
├── config.ts                         # Configuration parsing
├── context-manager.ts                # Stats, prune, pin (legacy tools)
├── types.ts                          # Shared types
│
├── engine/
│   ├── context-engine.ts             # Core: assemble() + compact() + topic classification
│   │                                 #   + normalizeMessageContent (Phase 4)
│   ├── adapter.ts                    # OpenClaw ContextEngine interface adapter
│   │                                 #   + ingest() lifecycle (async index + subtopic)
│   ├── summary-cache.ts             # Disk-persisted LLM summaries
│   ├── tool-result-cache.ts         # Disk-persisted head+tail truncated tool results
│   └── index.ts
│
├── session-index/
│   ├── builder.ts                    # JSONL → session index (incremental)
│   ├── parser.ts                     # Low-level JSONL line parser
│   ├── query.ts                      # Query API: stats, turns, topics
│   ├── persistence.ts                # Index save/load (.index.json)
│   ├── types.ts                      # TurnIndex, TopicIndex, etc.
│   └── index.ts
│
├── topic/
│   ├── topic-segmenter.ts            # Embedding + LLM segmentation pipeline
│   ├── embedding-detector.ts         # Cosine similarity boundary detection
│   ├── llm-classifier.ts             # LLM boundary confirmation + labeling
│   ├── subtopic-detector.ts          # Within-topic sub-task detection
│   ├── subtopic-cache.ts             # Sub-topic result disk cache
│   ├── types.ts                      # TopicBoundary, TopicSegment, config
│   └── index.ts
│
├── strategies/
│   ├── prune.ts                      # fifo, sliding-window, importance
│   └── index.ts
│
└── utils/
    ├── tokens.ts                     # Token estimation
    └── index.ts
```

### Design Principles

- **Append-only transcripts** — session JSONL is never modified. Summaries live in side caches. Full recovery is always possible.
- **Incremental pre-compression** — every assemble checks budget and compresses incrementally (drop → truncate → summarize), never waits for a big-bang compaction.
- **Per-turn topic classification** — lightweight async LLM call (~200 tokens) triggered by ingest lifecycle, results cached in index.
- **KV cache stability** — once content is compressed (truncated/summarized), it stays stable. No oscillation between assembles.
- **Graceful degradation** — no LLM available? Falls back to local heuristic extraction.
- **Turn-based, not message-based** — a turn (user → assistant round-trip) is the natural compression unit.
- **Runtime compatibility** — output normalized to ContentPart[] format for OpenClaw Pi runtime.

---

## Data Flow Detail

```
Session JSONL (never modified):                    Side Caches:
┌──────────────────────────────┐     ┌──────────────────────────────────┐
│ line 1: system prompt        │     │ .summary-cache.json              │
│ line 2: user "how's weather" │     │   turn-0 → "Asked about weather │
│ line 3: asst "It's sunny..." │     │             in Shanghai..."      │
│ line 4: user "build plugin"  │     │   turn-1 → "Started plugin..."  │
│ ...                          │     └──────────────────────────────────┘
│ line 400: user "run tests"   │     ┌──────────────────────────────────┐
│ line 401: asst "All pass!" ✓ │     │ .toolresults.json                │
└──────────────────────────────┘     │   turn-3/msg-2 → head+tail      │
                                     │   turn-5/msg-4 → head+tail      │
        ┌─────────────┐             └──────────────────────────────────┘
        │ .index.json │             ┌──────────────────────────────────┐
        │  turn map   │             │ .subtopic-cache.json             │
        │  topic map  │◀────────────│   topic-dev → [{arch}, {code},  │
        │  line ranges│             │               {debug}, {test}]  │
        │  subtopicId │             └──────────────────────────────────┘
        └─────────────┘
```

---

## Pruning Strategies

For the `context_prune` tool (message-level, separate from the turn-level engine):

| Strategy | Description |
|---|---|
| `fifo` | Oldest messages pruned first (default) |
| `sliding-window` | Keep the N most recent messages |
| `importance` | Score-based: role weight × tool presence × content length × recency |

---

## Development

```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run dev       # Watch mode (auto-rebuild)
npm run lint      # Lint
```

### Local Testing

1. `npm run build`
2. Set `plugins.load.paths` in `openclaw.json` to point here
3. `openclaw gateway restart`
4. Ask the agent: "What's the context engine status?" — if it responds with stats, you're good

## Requirements

- **OpenClaw** ≥ 2026.3.24-beta.2
- **Node.js** ≥ 20
- **TypeScript** ≥ 5.7 (development)

## Changelog

See [git log](https://github.com/wuxcer/openclaw-contextfold) for full history.

### Recent

- **Phase 4: Content normalization** — all assembled messages now have `content` as `ContentPart[]` for OpenClaw Pi runtime compatibility
- **Ingest lifecycle** — adapter now hooks `ingest()` to trigger async index updates and subtopic detection on turn completion
- **Per-turn subtopicId** — stored directly in `TurnIndex` for O(1) lookup during assemble
- **Selective LLM compaction** — only top-N largest turns are compressed per cycle
- **Tool result head+tail truncation** — large tool results cached with 40K char limit (zero-cost)

## License

[MIT](./LICENSE)
