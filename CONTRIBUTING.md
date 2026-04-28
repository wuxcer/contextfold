# Contributing to ContextFold

Thanks for your interest in contributing! ContextFold is a context folding plugin for the OpenClaw ecosystem.

## Getting Started

```bash
git clone https://github.com/anthropics/openclaw-contextfold.git
cd openclaw-contextfold
npm install
npm run build
```

## Project Structure

See [README.md](./README.md#architecture) for the full architecture overview.

Key areas:

- `src/engine/` — Core context engine (assemble/compact lifecycle)
- `src/topic/` — Topic segmentation and sub-topic detection
- `src/session-index/` — JSONL parsing and incremental indexing
- `src/strategies/` — Pruning strategies (fifo, sliding-window, importance)

## Development Workflow

1. **Make changes** in `src/`
2. **Build**: `npm run build`
3. **Test locally**: Configure load path in `openclaw.json`, restart gateway
4. **Verify**: Use the agent tools (`context_engine_status`, etc.) to test

## Code Style

- TypeScript strict mode
- ESM modules (`.js` extensions in imports)
- Descriptive variable names — no abbreviations
- JSDoc comments on exported functions and types
- Chinese comments are fine for internal notes; English for public API docs

## Guidelines

### Do

- Keep the session JSONL append-only — never modify or delete original messages
- Cache LLM results to disk — avoid redundant API calls
- Handle graceful degradation (no LLM available → fall back to heuristics)
- Add types for all public interfaces

### Don't

- Break the assemble/compact/recover contract
- Introduce external dependencies without discussion
- Make synchronous file I/O calls in hot paths

## Submitting Changes

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-improvement`
3. Commit with clear messages
4. Open a pull request

## Reporting Issues

Open an issue on GitHub with:
- OpenClaw version (`openclaw --version`)
- Plugin version
- Steps to reproduce
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
