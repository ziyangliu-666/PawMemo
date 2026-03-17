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

### ~~Schema migration (study entry + card learning state separation)~~ ✓ Done
**What:** Migrated bootstrap `review_cards` → `study_card + card_learning_state`; `word_mastery` → `study_entry + entry_memory_state`.
**Fix:** V4 migration drops old tables and creates 4 new tables. `StudyCardRepository` (replaces `ReviewCardRepository`) owns all public JOINs; `StudyEntryRepository` (replaces `MasteryRepository`) handles both `study_entry` and `entry_memory_state` inline. `ReviewCardRecord` → `StudyCardRecord`, `WordMasteryRecord` → `StudyEntryRecord`. `StatsQueryRepository.countDue` lifecycle filter bug fixed. `review_history` column renamed `review_card_id` → `study_card_id`. Indexes added on `card_learning_state(state, due_at)` and `study_card(lifecycle_state)`.
**Verified:** 166/166 tests pass (shell-runner OOM is pre-existing, unrelated to migration).

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

### ~~Queue index optimization~~ ✓ Done
**What:** Added indexes on `card_learning_state(state, due_at)` and `study_card(lifecycle_state)` as part of V4 migration.
**Fix:** Included in the schema migration PR — `idx_card_learning_state_due` and `idx_study_card_lifecycle`.

---

### ShellPlannerDecision union grouping
**What:** Group card operations into a sub-union within `ShellPlannerDecision`.
**Why:** Currently 14 top-level variants; will become unwieldy by variant 20.
**Context:** `{ kind: 'card'; op: 'create' | 'update' | 'set-lifecycle' | 'delete' | 'list'; input: ... }` would keep the top-level union stable as new card operations are added. Do before the next card-ops expansion.
**Effort:** M
**Depends on:** None

---

### ~~Card lifecycle idempotency validation~~ ✓ Done
**What:** Add state-machine validation in `CardWorkspaceService` so 'archive already-archived' fails clearly.
**Fix:** In `setLifecycle`, check `current.lifecycleState === input.lifecycleState` before executing the mutation. Throws `UsageError` with a clear message like "Card #3 is already archived."

---

### ~~Stable word collection milestone moments~~ ✓ Done
**What:** Detect milestone stable-word counts (10/25/50/100/250) in stats and surface a companion moment.
**Fix:** In `runStats`, check `masteryBreakdown.stable` against `STABLE_MILESTONES = [10, 25, 50, 100, 250]`. When exactly at a milestone, appends `\n\n* N words stable.` to the stats reply text.

---

## Architecture Diagrams (to add to `.agent/control/`)

- Card lifecycle state machine with explicit transitions
- Voice bank event key taxonomy
- `ShellPlannerDecision` tree (before the union grows further)
