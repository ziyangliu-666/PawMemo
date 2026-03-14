import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRecoveryPolicy,
  RETURN_AFTER_GAP_THRESHOLD_HOURS
} from "../src/core/orchestration/recovery-policy";

test("evaluateRecoveryPolicy requires prior review history before any return-after-gap state", () => {
  const result = evaluateRecoveryPolicy({
    lastReviewedAt: null,
    hoursSinceLastReview: RETURN_AFTER_GAP_THRESHOLD_HOURS * 2
  });

  assert.deepEqual(result, {
    hasPriorReviewHistory: false,
    isReturnAfterGap: false
  });
});

test("evaluateRecoveryPolicy stays false just below the return-after-gap threshold", () => {
  const result = evaluateRecoveryPolicy({
    lastReviewedAt: "2026-03-01T09:00:00.000Z",
    hoursSinceLastReview: RETURN_AFTER_GAP_THRESHOLD_HOURS - 1
  });

  assert.deepEqual(result, {
    hasPriorReviewHistory: true,
    isReturnAfterGap: false
  });
});

test("evaluateRecoveryPolicy flips on exactly at the return-after-gap threshold", () => {
  const result = evaluateRecoveryPolicy({
    lastReviewedAt: "2026-03-01T09:00:00.000Z",
    hoursSinceLastReview: RETURN_AFTER_GAP_THRESHOLD_HOURS
  });

  assert.deepEqual(result, {
    hasPriorReviewHistory: true,
    isReturnAfterGap: true
  });
});

test("evaluateRecoveryPolicy requires a measured elapsed time even when history exists", () => {
  const result = evaluateRecoveryPolicy({
    lastReviewedAt: "2026-03-01T09:00:00.000Z",
    hoursSinceLastReview: null
  });

  assert.deepEqual(result, {
    hasPriorReviewHistory: true,
    isReturnAfterGap: false
  });
});
