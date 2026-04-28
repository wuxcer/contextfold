# ContextFold

**Lossless context folding for [OpenClaw](https://github.com/openclaw/openclaw) agents.**

Detect topic boundaries → fold old conversations → keep what matters → unfold on demand.

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

### Three-Phase Lifecycle

```
┌─────────┐     Index turns, detect topic boundaries
│  Ingest  │────▶ (embedding similarity + LLM confirmation)
└────┬─────┘
     │
┌────▼─────┐     Compose the model's input:
│ Assemble  │────▶ Recent turns → full · Same topic → summaries · Other topics → one-liners
└────┬─────┘
     │
┌────▼─────┐     Generate & cache summaries for old turns
│  Compact  │────▶ Detect sub-topics within each major topic
└──────────┘     Original JSONL untouched
```

### Two-Layer Topic Detection

**Layer 1: Embedding coarse detection** — Cosine similarity between adjacent turns finds major topic shifts (weather → coding → dinner)

**Layer 2: LLM sub-topic detection** — Within each topic, an LLM identifies finer task boundaries (architecture → coding → debugging → testing)

### Folding Strategy

| Context | Treatment | Cost |
|---|---|---|
| Recent N turns | Kept in full | Original tokens |
| Same topic · current sub-topic | LLM summaries | ~10% |
| Same topic · completed sub-topics | `[Sub-topic: debugging — 8 turns, folded]` | ~15 tokens |
| Different topics | `[Topic: Weather — 3 turns, folded]` | ~15 tokens |

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
git clone https://github.com/wuxcer/contextfold
cd contextfold
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
      "paths": ["/path/to/contextfold"]
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
| `preserveRecentMessages` | number | `10` | Turns to always keep in full |

### Topic Detection Internals

| Parameter | Default | Description |
|---|---|---|
| `embeddingSimilarityThreshold` | `0.05` | Cosine similarity cutoff for topic boundaries |
| `minTurnsPerTopic` | `2` | Minimum turns for a standalone topic |
| `enableLlmConfirmation` | `true` | LLM-confirm embedding-detected boundaries |
| `sameTopicMaxTurns` | `5` | Max old same-topic turns kept as summaries |
| `crossTopicStrategy` | `"drop"` | Cross-topic handling: `"drop"` or `"summarize"` |

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
│   ├── context-engine.ts             # Core: assemble() + compact() + topic-aware folding
│   ├── adapter.ts                    # OpenClaw ContextEngine interface adapter
│   ├── summary-cache.ts             # Disk-persisted LLM summaries
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
- **Incremental indexing** — index updates as new messages arrive, no full re-parse.
- **Cached LLM calls** — summaries and topic classifications persist to disk. Re-running compact costs zero LLM calls for already-processed turns.
- **Graceful degradation** — no LLM available? Falls back to local heuristic extraction.
- **Turn-based, not message-based** — a turn (user → assistant round-trip) is the natural compression unit.

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
│ line 401: asst "All pass!" ✓ │     │ .subtopic-cache.json             │
└──────────────────────────────┘     │   topic-dev → [{arch}, {code},  │
                                     │               {debug}, {test}]  │
        ┌─────────────┐             └──────────────────────────────────┘
        │ .index.json │             ┌──────────────────────────────────┐
        │  turn map   │             │ Session index refreshes on each  │
        │  topic map  │◀────────────│ ingest, cached to disk           │
        │  line ranges│             └──────────────────────────────────┘
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

## License

[MIT](./LICENSE)
