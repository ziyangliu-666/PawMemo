import test from "node:test";
import assert from "node:assert/strict";

import type {
  MasteryState,
  ReviewCardState,
  ReviewGrade
} from "../src/core/domain/models";
import { scheduleReview } from "../src/review/scheduler";

interface TransitionCase {
  state: ReviewCardState;
  grade: ReviewGrade;
  stability: number;
  difficulty: number;
  expected: {
    nextState: ReviewCardState;
    dueAt: string;
    scheduledDays: number;
    stability: number;
    difficulty: number;
    masteryState: MasteryState;
  };
}

const REVIEWED_AT = "2026-03-12T00:00:00.000Z";

const transitionCases: TransitionCase[] = [
  {
    state: "new",
    grade: "again",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "learning",
      dueAt: "2026-03-12T00:10:00.000Z",
      scheduledDays: 10 / 1440,
      stability: 0.2,
      difficulty: 0.7,
      masteryState: "seen"
    }
  },
  {
    state: "new",
    grade: "hard",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "learning",
      dueAt: "2026-03-12T12:00:00.000Z",
      scheduledDays: 0.5,
      stability: 1,
      difficulty: 0.6,
      masteryState: "seen"
    }
  },
  {
    state: "new",
    grade: "good",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-14T00:00:00.000Z",
      scheduledDays: 2,
      stability: 2,
      difficulty: 0.45,
      masteryState: "familiar"
    }
  },
  {
    state: "new",
    grade: "easy",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-16T00:00:00.000Z",
      scheduledDays: 4,
      stability: 4,
      difficulty: 0.4,
      masteryState: "receptive"
    }
  },
  {
    state: "learning",
    grade: "again",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "learning",
      dueAt: "2026-03-12T00:10:00.000Z",
      scheduledDays: 10 / 1440,
      stability: 0.2,
      difficulty: 0.7,
      masteryState: "seen"
    }
  },
  {
    state: "learning",
    grade: "hard",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "learning",
      dueAt: "2026-03-13T00:00:00.000Z",
      scheduledDays: 1,
      stability: 1,
      difficulty: 0.6,
      masteryState: "familiar"
    }
  },
  {
    state: "learning",
    grade: "good",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-15T00:00:00.000Z",
      scheduledDays: 3,
      stability: 2,
      difficulty: 0.45,
      masteryState: "receptive"
    }
  },
  {
    state: "learning",
    grade: "easy",
    stability: 0,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-17T00:00:00.000Z",
      scheduledDays: 5,
      stability: 4,
      difficulty: 0.4,
      masteryState: "receptive"
    }
  },
  {
    state: "review",
    grade: "again",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "relearning",
      dueAt: "2026-03-12T00:10:00.000Z",
      scheduledDays: 10 / 1440,
      stability: 0.5,
      difficulty: 0.7,
      masteryState: "seen"
    }
  },
  {
    state: "review",
    grade: "hard",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-14T00:00:00.000Z",
      scheduledDays: 2,
      stability: 1.2,
      difficulty: 0.6,
      masteryState: "familiar"
    }
  },
  {
    state: "review",
    grade: "good",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-16T00:00:00.000Z",
      scheduledDays: 4,
      stability: 2,
      difficulty: 0.45,
      masteryState: "receptive"
    }
  },
  {
    state: "review",
    grade: "easy",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-21T00:00:00.000Z",
      scheduledDays: 9,
      stability: 3,
      difficulty: 0.4,
      masteryState: "productive"
    }
  },
  {
    state: "relearning",
    grade: "again",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "relearning",
      dueAt: "2026-03-12T00:10:00.000Z",
      scheduledDays: 10 / 1440,
      stability: 0.5,
      difficulty: 0.7,
      masteryState: "seen"
    }
  },
  {
    state: "relearning",
    grade: "hard",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "relearning",
      dueAt: "2026-03-12T12:00:00.000Z",
      scheduledDays: 0.5,
      stability: 1.2,
      difficulty: 0.6,
      masteryState: "seen"
    }
  },
  {
    state: "relearning",
    grade: "good",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-14T00:00:00.000Z",
      scheduledDays: 2,
      stability: 2,
      difficulty: 0.45,
      masteryState: "familiar"
    }
  },
  {
    state: "relearning",
    grade: "easy",
    stability: 1,
    difficulty: 0.5,
    expected: {
      nextState: "review",
      dueAt: "2026-03-16T00:00:00.000Z",
      scheduledDays: 4,
      stability: 3,
      difficulty: 0.4,
      masteryState: "receptive"
    }
  }
];

test("scheduleReview covers every review-state and grade transition", async (t) => {
  for (const testCase of transitionCases) {
    await t.test(`${testCase.state} -> ${testCase.grade}`, () => {
      const result = scheduleReview({
        state: testCase.state,
        grade: testCase.grade,
        reviewedAt: REVIEWED_AT,
        stability: testCase.stability,
        difficulty: testCase.difficulty
      });

      assert.deepEqual(result, testCase.expected);
    });
  }
});

test("scheduleReview clamps difficulty inside the supported range", () => {
  const lowDifficulty = scheduleReview({
    state: "learning",
    grade: "easy",
    reviewedAt: REVIEWED_AT,
    stability: 0,
    difficulty: 0.05
  });

  const highDifficulty = scheduleReview({
    state: "review",
    grade: "again",
    reviewedAt: REVIEWED_AT,
    stability: 4,
    difficulty: 0.95
  });

  assert.equal(lowDifficulty.difficulty, 0);
  assert.equal(highDifficulty.difficulty, 1);
});

test("scheduleReview falls back to base stability for non-positive stability inputs", () => {
  const result = scheduleReview({
    state: "review",
    grade: "good",
    reviewedAt: REVIEWED_AT,
    stability: -3,
    difficulty: 0.4
  });

  assert.equal(result.stability, 2);
  assert.equal(result.scheduledDays, 4);
  assert.equal(result.masteryState, "receptive");
});

test("scheduleReview scales long review intervals from updated stability once above the floor", () => {
  const result = scheduleReview({
    state: "review",
    grade: "easy",
    reviewedAt: REVIEWED_AT,
    stability: 8,
    difficulty: 0.5
  });

  assert.equal(result.stability, 24);
  assert.equal(result.scheduledDays, 72);
  assert.equal(result.masteryState, "stable");
});
