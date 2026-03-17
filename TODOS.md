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

### Richer voice bank event keys
**What:** Expand voice bank from 4-6 event keys to 10-15 covering the full companion emotional surface.
**Why:** Deeper event coverage makes the companion feel like it's actually watching progress.
**Context:** Current keys: `status_snapshot`, `idle_prompt`, `stats_summary`, `review_session_empty`. Add: `re_capture_detection`, `word_stabilized`, `streak_milestone` (3/7/14/30 days), `shell_exit_farewell`, `rescue_complete_counter`, `card_created`.
**Effort:** M
**Depends on:** None

---

### Schema migration (study entry + card learning state separation)
**What:** Migrate bootstrap `review_cards` to `study_entry + study_card + entry_memory_state + card_learning_state`.
**Why:** The current table conflates card content and scheduler state, blocking the card-native workspace vision.
**Context:** Bootstrap schema has `review_cards` with both content fields (front, back, word) and scheduler fields (stability, difficulty, due_at, review_state). The clean model separates these. All downstream code (repositories, card workspace service, queue selection) needs updating.
**Effort:** XL
**Depends on:** Warmth improvements shipped first (streaming + voice bank + warmth polish)

---

## P2

### SQLite error actionable guidance
**What:** Add SQLite error class detection in `presentShellError` with recovery guidance.
**Why:** Locked/corrupt DB currently shows "Something slipped" with no actionable guidance.
**Context:** `better-sqlite3` throws errors with a distinct class. Catch it and show: "There's a problem with your study database. Try `pawmemo --db /tmp/test.db` to verify, or check that `pawmemo.db` isn't locked by another process."
**Effort:** S
**Depends on:** None

---

### LLM provider circuit breaker / warm degradation mode
**What:** After N consecutive provider failures, surface a 'resting mode' companion state.
**Why:** Repeated "I couldn't reach the model" messages feel broken; warm degradation makes it intentional.
**Context:** Track consecutive `ProviderRequestError` count in shell session state. After 3 failures, companion switches to template-only mode with copy like "My connection's resting — but you can still capture, review, and rescue." Full planner reactivates on next successful call.
**Effort:** M
**Depends on:** None

---

### Learning trend observability in /stats
**What:** Add a 'trend' projection showing words stabilizing vs. stuck in relearning.
**Why:** Makes the learning engine visible rather than just felt.
**Context:** `review_history` already has grade data over time. A simple bucketing (words with 3+ consecutive good/easy grades = "trending stable"; words with 2+ recent again/hard = "needs attention") would be a meaningful signal. Surface in `presentShellStatsResult`.
**Effort:** M
**Depends on:** None

---

### GitHub Release automation
**What:** GitHub Actions workflow that attaches `.tgz` to GitHub Release on version tags.
**Why:** v0.1.0 is packaged but no formal release created. Manual releases are fragile.
**Context:** CI already runs `npm pack`. Add one workflow triggered by `v*` tags: build → npm pack → create GitHub Release → attach `.tgz`. Follows existing CI pattern.
**Effort:** S
**Depends on:** None

---

### Re-capture detection with companion memory commentary
**What:** When a word is captured that's already in the list, companion acknowledges it instead of a generic error.
**Why:** "Oh, luminous again! You've seen it 3 times." makes the companion feel like it remembers.
**Context:** Currently `DuplicateEncounterError` is humanized to "I already have that word in the pile." Instead, look up the existing encounter count and route through a `re_capture` voice bank event with the count as context. The error path becomes a warm moment.
**Effort:** S
**Depends on:** Richer voice bank event keys (`re_capture_detection` key)

---

### First-stability celebration
**What:** When a word reaches 'stable' mastery state for the first time, emit a specific companion moment.
**Why:** "You locked in luminous. 永远记住了。" marks a real milestone rather than letting it pass silently.
**Context:** The grading path in `ReviewService` already computes the new mastery state. Check if the previous mastery state was below `stable` and the new one is `stable`. Emit a `word_stabilized` companion event with the word name. Route through voice bank with `word_stabilized` key.
**Effort:** S-M
**Depends on:** Richer voice bank event keys (`word_stabilized` key)

---

### Shell exit farewell
**What:** Companion delivers a brief farewell on /quit or second Ctrl+C, referencing one recent word.
**Why:** Leaving the shell should feel like a moment, not just a process exit.
**Context:** Shell exit flows through exit confirmation state. On confirmed exit, before teardown, show one line from a `shell_exit_farewell` voice bank template that references the most recent saved word. Falls back to pack template if voice bank isn't populated.
**Effort:** XS
**Depends on:** Richer voice bank event keys (`shell_exit_farewell` key)

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

### Stable word collection milestone moments
**What:** Detect milestone stable-word counts (10/25/50/100/250) in stats and surface a companion moment.
**Why:** "✶ 50 words stable!" marks long-term progress in a way raw counts don't.
**Context:** `CompanionSignals` already has `stableCount`. In `presentShellStatsResult`, check if `stableCount` crosses a milestone threshold. Surface a one-line companion moment after the stats block.
**Effort:** XS
**Depends on:** None

---

## Architecture Diagrams (to add to `.agent/control/`)

- Card lifecycle state machine with explicit transitions
- Voice bank event key taxonomy
- `ShellPlannerDecision` tree (before the union grows further)
