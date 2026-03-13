import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { ReviewService } from "../src/core/orchestration/review-service";
import { ReviewCardNotDueError } from "../src/lib/errors";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("ReviewService prioritizes due review cards ahead of new cards within preference budgets", () => {
  const dbPath = tempDbPath("queue");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    capture.capture({
      word: "brisk",
      context: "We took a brisk walk before sunrise.",
      gloss: "quick and energetic",
      capturedAt: "2026-03-12T00:00:01.000Z"
    });

    db.prepare(
      `
        UPDATE user_preferences
        SET daily_review_limit = 1, daily_new_limit = 1
        WHERE id = 1
      `
    ).run();

    db.prepare(
      `
        UPDATE review_cards
        SET state = 'review', due_at = '2026-03-11T00:00:00.000Z'
        WHERE id = 1
      `
    ).run();

    const service = new ReviewService(db);
    const result = service.getQueue({
      now: "2026-03-12T12:00:00.000Z"
    });

    assert.equal(result.totalDue, 4);
    assert.equal(result.returnedCount, 2);
    assert.equal(result.items[0].id, 1);
    assert.equal(result.items[0].state, "review");
    assert.equal(result.items[1].state, "new");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ReviewService writes review history and updates card plus mastery", () => {
  const dbPath = tempDbPath("grade");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const grade = new ReviewService(db);
    const result = grade.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2026-03-12T00:00:00.000Z"
    });

    assert.equal(result.card.state, "review");
    assert.equal(result.card.dueAt, "2026-03-14T00:00:00.000Z");
    assert.equal(result.mastery.state, "familiar");
    assert.equal(result.scheduledDays, 2);

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM review_history) AS history_count,
            (SELECT COUNT(*) FROM event_log WHERE event_type = 'review.graded') AS graded_events
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.history_count, 1);
    assert.equal(counts.graded_events, 1);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ReviewService rejects cards that are not yet due", () => {
  const dbPath = tempDbPath("not-due");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const grade = new ReviewService(db);

    assert.throws(
      () =>
        grade.grade({
          cardId: 1,
          grade: "good",
          reviewedAt: "2026-03-11T23:59:00.000Z"
        }),
      ReviewCardNotDueError
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
