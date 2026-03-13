# PawMemo

PawMemo is a local-first vocabulary companion with a deterministic learning core and a TUI-first terminal shell.

Its core boundary is deliberate: companion tone can shape pacing, warmth, and return moments, but study truth still lives in explicit word state, retrieval, and spaced-review scheduling.

## What It Does

- stores words, context, and glosses in SQLite
- builds deterministic review cards
- supports `review`, `review session`, `rescue`, `ask`, `teach`, `pet`, `stats`, and `shell`
- keeps the learning engine separate from companion rendering
- supports multiple companion packs without changing study truth
- opens straight into the shell when you run `pawmemo`

## Current CLI Behavior

- `pawmemo` opens the shell directly
- in a real terminal, the default shell is the full-screen TUI
- `pawmemo --line` forces the line-shell fallback
- `pawmemo shell` is still available, but no longer required
- the default database path is `.data/pawmemo.db` under the current working directory
- `PAWMEMO_DB_PATH` or `--db /path/to/db.sqlite` can override that path

## Install

### From this repo for local development

```bash
npm install
npm run build
npm link
```

Then launch PawMemo with:

```bash
pawmemo
```

### From a packaged tarball

Build the package:

```bash
npm pack
```

Install the generated tarball:

```bash
npm install -g ./pawmemo-0.1.0.tgz
```

Then launch it:

```bash
pawmemo
```

Notes:

- `npm pack` builds `dist/` automatically before packing
- the published package ships runtime files only, so the installed CLI can run immediately

## Quick Start

The shortest path is:

```bash
pawmemo
```

Inside the shell:

```text
/help
/review
/rescue
/stats
/models
/quit
```

If you want an isolated scratch database while exploring:

```bash
pawmemo --db /tmp/pawmemo-dev.db
```

If your terminal has trouble with the full-screen interface:

```bash
pawmemo --line --db /tmp/pawmemo-dev.db
```

## First 3 Minutes

No model is required for the local study loop. These commands work without LLM setup:

```bash
pawmemo capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"
pawmemo review
pawmemo review session --limit 5
pawmemo rescue
pawmemo stats
```

If you want natural chat plus `ask` and `teach`, configure a provider first:

```bash
pawmemo config llm
pawmemo config llm use --provider openai --model gpt-5-mini --api-key "your-key"
```

Then either stay in the shell:

```bash
pawmemo
```

Or call direct commands:

```bash
pawmemo ask luminous --ctx "The jellyfish gave off a luminous glow."
pawmemo teach lucid --ctx "Her explanation was lucid and easy to follow."
```

## Shell Notes

- `/models` opens an interactive provider and model picker inside the shell
- `/model` shows or updates explicit model settings
- `Tab`, arrow keys, and `Enter` work in the TUI picker flows
- `Ctrl+C` in the TUI is a two-step exit confirmation

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
