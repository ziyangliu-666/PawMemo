import test from "node:test";
import assert from "node:assert/strict";

import {
  formatHomeProjection
} from "../src/cli/format";
import {
  presentShellReviewSessionSummary,
  presentShellStatsResult
} from "../src/cli/shell-presenter";
import type {
  HomeProjectionResult,
  StatsSummaryResult
} from "../src/core/domain/models";

function summary(
  overrides: Partial<StatsSummaryResult> = {}
): StatsSummaryResult {
  return {
    generatedAt: "2026-03-12T12:00:00.000Z",
    todayReviewedCount: 0,
    dueCount: 2,
    dueReviewCount: 1,
    dueNewCount: 1,
    capturedLast7Days: 1,
    reviewedLast7Days: 1,
    masteryBreakdown: {
      unknown: 0,
      seen: 1,
      familiar: 0,
      receptive: 0,
      productive: 0,
      stable: 0
    },
    ...overrides
  };
}

function home(
  overrides: Partial<HomeProjectionResult> = {}
): HomeProjectionResult {
  return {
    generatedAt: "2026-03-12T12:00:00.000Z",
    dueCount: 2,
    recentWord: "luminous",
    focusWord: "luminous",
    focusReason: "rescue",
    hasPriorReviewHistory: true,
    isReturnAfterGap: true,
    returnGapDays: 11,
    rescueCandidate: null,
    entryKind: "return_rescue",
    suggestedNextAction: "rescue",
    canStopAfterPrimaryAction: true,
    optionalNextAction: "review",
    ...overrides
  };
}

test("presentShellStatsResult turns return-and-rescue into a gentle re-entry plan", () => {
  const text = presentShellStatsResult(
    summary(),
    home()
  );

  assert.match(text, /came back after 11 days/i);
  assert.match(text, /do not need the whole pile/i);
  assert.match(text, /"luminous"/i);
  assert.match(text, /stop or do one more/i);
});

test("presentShellReviewSessionSummary frames rescue completion as reconnecting the line", () => {
  const text = presentShellReviewSessionSummary(
    {
      reviewedCount: 1,
      quitEarly: false,
      limitReached: false,
      gradeCounts: {
        again: 0,
        hard: 0,
        good: 1,
        easy: 0
      }
    },
    null,
    {
      mode: "rescue",
      focusWord: "luminous"
    }
  );

  assert.match(text, /"luminous" is back with you now/i);
  assert.match(text, /mattered most right now/i);
  assert.match(text, /stop there or do one more later/i);
});

test("formatHomeProjection presents home as a gentle entry surface instead of a raw dashboard", () => {
  const text = formatHomeProjection(home());

  assert.match(text, /^Home/m);
  assert.match(text, /Today: rescue "luminous" first/i);
  assert.match(text, /Pace: do not take the whole pile at once/i);
  assert.match(text, /After this: once "luminous" is back, today counts as reconnected/i);
  assert.match(text, /Optional next: review one more/i);
});
