import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { GetCompanionSignalsService } from "../src/core/orchestration/get-companion-signals";
import { ReviewService } from "../src/core/orchestration/review-service";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("GetCompanionSignalsService summarizes due work, recent activity, and mastery distribution", () => {
  const dbPath = tempDbPath("stats");
  const db = openDatabase(dbPath);

  try {
    const captureService = new CaptureWordService(db);
    const gradeService = new ReviewService(db);
    const statsService = new GetCompanionSignalsService(db);

    captureService.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-10T09:00:00.000Z"
    });

    captureService.capture({
      word: "lucid",
      context: "Her explanation was lucid and easy to follow.",
      gloss: "clear and easy to understand",
      capturedAt: "2026-03-12T09:30:00.000Z"
    });

    gradeService.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2026-03-12T11:00:00.000Z"
    });

    const summary = statsService.getSignals("2026-03-12T12:00:00.000Z");

    assert.equal(summary.todayReviewedCount, 1);
    assert.equal(summary.dueCount, 3);
    assert.equal(summary.dueReviewCount, 0);
    assert.equal(summary.dueNewCount, 3);
    assert.equal(summary.capturedLast7Days, 2);
    assert.equal(summary.reviewedLast7Days, 1);
    assert.equal(summary.masteryBreakdown.familiar, 1);
    assert.equal(summary.masteryBreakdown.seen, 1);
    assert.equal(summary.masteryBreakdown.stable, 0);
    assert.equal(summary.recentWord, "lucid");
    assert.equal(summary.stableCount, 0);
    assert.equal(summary.lastReviewedAt, "2026-03-12T11:00:00.000Z");
    assert.equal(summary.hoursSinceLastReview, 1);
    assert.equal(summary.daysSinceLastReview, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
