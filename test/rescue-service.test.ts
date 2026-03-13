import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { RescueService } from "../src/core/orchestration/rescue-service";
import { ReviewService } from "../src/core/orchestration/review-service";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("RescueService returns the most overdue review-side card and ignores new cards", () => {
  const dbPath = tempDbPath("rescue-service");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-01T00:00:00.000Z"
    });
    capture.capture({
      word: "lucid",
      context: "Her explanation was lucid and easy to follow.",
      gloss: "clear and easy to understand",
      capturedAt: "2026-03-02T00:00:00.000Z"
    });

    review.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2026-03-01T00:00:00.000Z"
    });
    review.grade({
      cardId: 3,
      grade: "good",
      reviewedAt: "2026-03-06T00:00:00.000Z"
    });

    const rescue = new RescueService(db);
    const candidate = rescue.getCandidate("2026-03-12T12:00:00.000Z");

    assert.ok(candidate);
    assert.equal(candidate.card.id, 1);
    assert.equal(candidate.card.lemma, "luminous");
    assert.equal(candidate.card.state, "review");
    assert.ok(candidate.overdueDays >= 9);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
