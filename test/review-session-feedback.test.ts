import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReturnAfterGapSummary,
  buildReviewSessionCompanionEvent
} from "../src/cli/review-session-feedback";
import type { CompanionSignalsResult } from "../src/core/domain/models";

function signals(
  overrides: Partial<CompanionSignalsResult> = {}
): CompanionSignalsResult {
  return {
    generatedAt: "2026-03-12T12:00:00.000Z",
    todayReviewedCount: 0,
    dueCount: 4,
    dueReviewCount: 2,
    dueNewCount: 2,
    capturedLast7Days: 1,
    reviewedLast7Days: 0,
    masteryBreakdown: {
      unknown: 0,
      seen: 1,
      familiar: 0,
      receptive: 0,
      productive: 0,
      stable: 0
    },
    recentWord: "luminous",
    stableCount: 0,
    lastReviewedAt: "2026-03-01T12:00:00.000Z",
    hoursSinceLastReview: 264,
    daysSinceLastReview: 11,
    ...overrides
  };
}

test("buildReturnAfterGapSummary requires real prior review history", () => {
  const result = buildReturnAfterGapSummary(
    signals({
      lastReviewedAt: null,
      hoursSinceLastReview: null,
      daysSinceLastReview: null
    }),
    signals({
      dueCount: 3,
      todayReviewedCount: 1,
      reviewedLast7Days: 1
    }),
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
    }
  );

  assert.equal(result, null);
});

test("buildReturnAfterGapSummary produces a factual recovery summary", () => {
  const summary = buildReturnAfterGapSummary(
    signals(),
    signals({
      dueCount: 3,
      todayReviewedCount: 1,
      reviewedLast7Days: 1
    }),
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
    }
  );

  assert.deepEqual(summary, {
    lastReviewedAt: "2026-03-01T12:00:00.000Z",
    gapDays: 11,
    reviewedCount: 1,
    dueCountBefore: 4,
    dueCountAfter: 3
  });

  assert.deepEqual(
    buildReviewSessionCompanionEvent(
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
      summary
    ),
    {
      type: "return_after_gap",
      reviewedCount: 1,
      gapDays: 11
    }
  );
});
