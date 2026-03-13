# PawMemo

PawMemo is a local-first vocabulary companion with a deterministic learning core and a conversational terminal surface.

It is opinionated about one boundary: companionship can shape tone, pacing, and re-entry feel, but it must not replace explicit word state, retrieval, or spaced-review scheduling.

## What It Does

- captures words with context and gloss into SQLite
- creates deterministic review cards
- supports `review`, `review session`, `rescue`, `ask`, `teach`, `pet`, and `shell`
- keeps the learning engine separate from companion rendering
- supports multiple companion packs without changing study truth
- includes an experimental full-screen `--tui` shell

## Why This Repo Exists

Many language-learning tools are either:

- rigid flashcard systems with no emotional continuity
- chat products that feel warm but hide learning truth inside prompts

PawMemo is trying to sit in the middle:

- deterministic, inspectable learning state
- a companion-led interaction surface
- gentle return/rescue rituals instead of backlog guilt

## Current Status

PawMemo is still early, but the core loop is real:

- capture words
- review due cards
- rescue the single most important overdue card
- talk to a shell that can route into study actions
- try the experimental TUI shell

The repo is controlled through `doc/`, which acts as the product and architecture control plane.

## Quick Start

```bash
npm install
npm run build
npm run lint
npm test
```

Run a few commands:

```bash
node dist/src/cli/index.js capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"
node dist/src/cli/index.js review
node dist/src/cli/index.js review session --limit 5
node dist/src/cli/index.js rescue
node dist/src/cli/index.js pet
node dist/src/cli/index.js shell
node dist/src/cli/index.js shell --tui
```

If you want an isolated local database while exploring:

```bash
node dist/src/cli/index.js shell --tui --db /tmp/pawmemo-dev.db
```

## Shell Modes

`pawmemo shell`

- line-oriented conversational shell
- fastest path to try natural chat, capture, ask, teach, and rescue

`pawmemo shell --tui`

- experimental full-screen terminal UI
- transcript, status row, composer, footer
- raw-mode inline composer with cursor movement

## LLM Configuration

PawMemo can run with or without a configured model.

Built-in providers:

- `gemini`
- `openai`
- `anthropic`

Examples:

```bash
node dist/src/cli/index.js config show
node dist/src/cli/index.js config llm
node dist/src/cli/index.js config llm use --provider openai --model gpt-5-mini --api-key "your-key"
node dist/src/cli/index.js config llm list-models --provider gemini
node dist/src/cli/index.js config companion list
node dist/src/cli/index.js config companion --pack girlfriend
```

Inside shell:

```text
/model
/model list
/model use openai gpt-5-mini
/quit
```

## Development

Useful commands:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Repository layout:

- `doc/`: product brief, architecture, implementation plan, decisions, progress
- `src/cli/`: CLI commands, shell runner, shell surface, TUI work
- `src/core/`: domain and orchestration
- `src/storage/`: SQLite database and repositories
- `src/review/`: card generation and review scheduling logic
- `src/companion/`: companion packs, reactions, rendering
- `test/`: integration and focused unit coverage

## Contributing

This repo is docs-first.

Before substantial work:

1. read `doc/00-index.md`
2. check `doc/10-progress.md`
3. check `doc/09-decision-log.md`

Working expectations:

- keep docs ahead of code
- keep scheduling deterministic
- keep companion behavior downstream of study truth
- avoid undocumented architectural drift

## License

MIT. See [LICENSE](./LICENSE).
