# PawMemo TODOs

Generated from CEO plan review (EXPANSION mode) — 2026-03-17.
Agreed sequence: streaming → voice bank → warmth → schema migration.

---

## P1

### ~~Real streaming for planner replies~~ ✓ Done
**What:** Provider-native delta delivery for shell planner reply/clarify turns.
**Fix:** Removed `response_format: json_object` (OpenAI) and `responseMimeType` (Gemini) from `generateTextStream` — proxies were buffering the full response before emitting deltas. Non-streaming paths keep the format hint.
**Verified:** Live MCP session confirmed `Perf: response elapsed: 0.3ms` after 14s planner call — text committed from already-rendered stream, not fake-streamed after the fact.

---

### ~~Richer voice bank event keys~~ ✓ Done
**What:** Expanded from 13 → 19 event keys covering the full companion emotional surface.
**Added:** `re_capture_detection` ({{encounterCount}}), `word_stabilized`, `streak_milestone` ({{streakDays}}), `rescue_complete_counter` ({{rescueCount}}), `card_created`, `shell_exit` (farewell).
**Also added:** `encounterCount`, `streakDays`, `rescueCount` placeholders to template context and interpolation.
**Note:** Keys are wired in voice bank and reaction-builder. Actual event firing (re-capture, grading mastery transition, streak calc, etc.) is the P2 wire-up work.

---

### Schema migration (study entry + card learning state separation)
**What:** Migrate bootstrap `review_cards` to `study_entry + study_card + entry_memory_state + card_learning_state`.
**Why:** The current table conflates card content and scheduler state, blocking the card-native workspace vision.
**Context:** Bootstrap schema has `review_cards` with both content fields (front, back, word) and scheduler fields (stability, difficulty, due_at, review_state). The clean model separates these. All downstream code (repositories, card workspace service, queue selection) needs updating.
**Effort:** XL
**Depends on:** Warmth improvements shipped first (streaming + voice bank + warmth polish)

---

## P2

### ~~SQLite error actionable guidance~~ ✓ Done
**What:** Add SQLite error class detection in `presentShellError` with recovery guidance.
**Fix:** In `presentShellError`, check `error.name === "SqliteError"` and dispatch on `error.code`: SQLITE_BUSY/LOCKED shows lock guidance; SQLITE_CORRUPT/NOTADB shows corruption guidance; other SQLite errors show the generic DB guidance with the `--db` verification tip.

---

### ~~LLM provider circuit breaker / warm degradation mode~~ ✓ Done
**What:** After N consecutive provider failures, surface a 'resting mode' companion state.
**Fix:** `consecutiveProviderFailures` counter in `ShellRunner`. After 3 consecutive `ProviderRequestError`s, planner-bound input short-circuits with a warm message listing still-usable slash commands. Resets on any successful turn or non-provider error. Slash commands always bypass LLM (fast-path in `ShellConversationAgent`) so they continue working unaffected.

---

### Learning trend observability in /stats
**What:** Add a 'trend' projection showing words stabilizing vs. stuck in relearning.
**Why:** Makes the learning engine visible rather than just felt.
**Context:** `review_history` already has grade data over time. A simple bucketing (words with 3+ consecutive good/easy grades = "trending stable"; words with 2+ recent again/hard = "needs attention") would be a meaningful signal. Surface in `presentShellStatsResult`.
**Effort:** M
**Depends on:** None

---

### ~~GitHub Release automation~~ ✓ Already done
**What:** GitHub Actions workflow that attaches `.tgz` to GitHub Release on version tags.
**Fix:** `.github/workflows/release-package.yml` already exists — triggered on `v*` tags, runs typecheck/lint/test, packs tarball, creates or uploads to GitHub Release via `gh release create/upload`.

---

### ~~Re-capture detection with companion memory commentary~~ ✓ Done
**What:** When a word is captured that's already in the list, companion acknowledges it instead of a generic error.
**Fix:** Added `countByLexemeId` to `EncounterRepository`, exposed `getEncounterCount(word)` in `ShellActionExecutor`. In `runCaptureInput`, catch `DuplicateEncounterError`, resolve count, fire `re_capture_detection` reaction (warm moment, recorded as action result not error). Voice bank template uses `{{encounterCount}}`.

---

### ~~First-stability celebration~~ ✓ Done
**What:** When a word reaches 'stable' mastery state for the first time, emit a specific companion moment.
**Fix:** After review session, compare `signalsBefore.stableCount` vs `signalsAfter.stableCount`. If increased, fire `word_stabilized` reaction with `recentWord` from post-session signals. Practical approximation — targets the common case without per-grade callbacks.

---

### ~~Shell exit farewell~~ ✓ Done
**What:** Companion delivers a brief farewell on /quit or second Ctrl+C, referencing one recent word.
**Fix:** Already wired at `shell-runner.ts:458` — `shell_exit` event fires on confirmed quit with `getStatusSignals()` (includes `recentWord`). Voice bank template uses `{{recentWord}}`. No code changes needed; event was in place from companion types work.

---

### Daily streak awareness
**What:** Track consecutive study days; companion comments at 3/7/14/30-day milestones.
**Why:** "Three days in a row! 好好学习 energy." creates a positive recurring moment.
**Context:** `review_history` timestamps enable streak calculation as a pure function. Add `streakDays: number` and `isNewStreakMilestone: boolean` to `CompanionSignals`. Route milestone events through voice bank. Only celebrate, never guilt — if the streak breaks, companion says nothing special.
**Effort:** M
**Depends on:** None

---

### 'Words saved from the edge' rescue counter
**What:** After rescue completion and in /stats, show a running tally of total rescued words.
**Why:** Makes the rescue ritual feel like a growing personal record.
**Context:** `event_log` already records rescue events. A simple count of `rescue_complete` events over the full event log gives the lifetime rescue count. Surface after rescue completion ("Words brought back: 7") and as a line in /stats.
**Effort:** S
**Depends on:** None

---

## P3

### Queue index optimization
**What:** Add composite index on `review_cards(lifecycle, review_state, due_at)`.
**Why:** Current full-table scan is fine at 1k cards; starts to matter at 10k+.
**Context:** Add as part of the schema migration slice since that will need a new migration anyway.
**Effort:** XS
**Depends on:** Schema migration milestone

---

### ShellPlannerDecision union grouping
**What:** Group card operations into a sub-union within `ShellPlannerDecision`.
**Why:** Currently 14 top-level variants; will become unwieldy by variant 20.
**Context:** `{ kind: 'card'; op: 'create' | 'update' | 'set-lifecycle' | 'delete' | 'list'; input: ... }` would keep the top-level union stable as new card operations are added. Do before the next card-ops expansion.
**Effort:** M
**Depends on:** None

---

### Card lifecycle idempotency validation
**What:** Add state-machine validation in `CardWorkspaceService` so 'archive already-archived' fails clearly.
**Why:** Current behavior on duplicate lifecycle transitions is unknown; explicit validation prevents confusing silent failures.
**Context:** Before executing a lifecycle mutation, check current lifecycle state. If already in target state, return early or throw a clear `UsageError`.
**Effort:** XS
**Depends on:** None

---

### ~~Stable word collection milestone moments~~ ✓ Done
**What:** Detect milestone stable-word counts (10/25/50/100/250) in stats and surface a companion moment.
**Fix:** In `runStats`, check `masteryBreakdown.stable` against `STABLE_MILESTONES = [10, 25, 50, 100, 250]`. When exactly at a milestone, appends `\n\n* N words stable.` to the stats reply text.

---

## Architecture Diagrams (to add to `.agent/control/`)

- Card lifecycle state machine with explicit transitions
- Voice bank event key taxonomy
- `ShellPlannerDecision` tree (before the union grows further)
