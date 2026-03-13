import test from "node:test";
import assert from "node:assert/strict";

import { scheduleReview } from "../src/review/scheduler";

test("scheduleReview promotes a new card graded good into review with a two-day interval", () => {
  const result = scheduleReview({
    state: "new",
    grade: "good",
    reviewedAt: "2026-03-12T00:00:00.000Z",
    stability: 0,
    difficulty: 0
  });

  assert.equal(result.nextState, "review");
  assert.equal(result.scheduledDays, 2);
  assert.equal(result.dueAt, "2026-03-14T00:00:00.000Z");
  assert.equal(result.stability, 2);
  assert.equal(result.difficulty, 0);
  assert.equal(result.masteryState, "familiar");
});

test("scheduleReview sends a review card graded again into relearning", () => {
  const result = scheduleReview({
    state: "review",
    grade: "again",
    reviewedAt: "2026-03-12T00:00:00.000Z",
    stability: 8,
    difficulty: 0.3
  });

  assert.equal(result.nextState, "relearning");
  assert.equal(result.scheduledDays, 10 / 1440);
  assert.equal(result.dueAt, "2026-03-12T00:10:00.000Z");
  assert.equal(result.stability, 4);
  assert.equal(result.difficulty, 0.5);
  assert.equal(result.masteryState, "seen");
});
