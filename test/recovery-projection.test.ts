import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { GetRecoveryProjectionService } from "../src/core/orchestration/get-recovery-projection";
import { ReviewService } from "../src/core/orchestration/review-service";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("GetRecoveryProjectionService combines return-gap and rescue readiness into one bounded read model", () => {
  const dbPath = tempDbPath("recovery-projection");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);
    const recovery = new GetRecoveryProjectionService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-01T09:00:00.000Z"
    });

    review.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2026-03-01T09:00:00.000Z"
    });

    const projection = recovery.getProjection("2026-03-12T12:00:00.000Z");

    assert.equal(projection.lastReviewedAt, "2026-03-01T09:00:00.000Z");
    assert.equal(projection.hasPriorReviewHistory, true);
    assert.equal(projection.isReturnAfterGap, true);
    assert.equal(projection.returnGapHours, 267);
    assert.equal(projection.returnGapDays, 11);
    assert.equal(projection.daysSinceLastReview, 11);
    assert.ok(projection.rescueCandidate);
    assert.equal(projection.rescueCandidate.card.lemma, "luminous");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("GetRecoveryProjectionService reports newcomer status before any review history exists", () => {
  const dbPath = tempDbPath("recovery-projection-newcomer");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const recovery = new GetRecoveryProjectionService(db);

    capture.capture({
      word: "lucid",
      context: "Her explanation was lucid and easy to follow.",
      gloss: "clear and easy to understand",
      capturedAt: "2026-03-12T09:00:00.000Z"
    });

    const projection = recovery.getProjection("2026-03-12T12:00:00.000Z");

    assert.equal(projection.lastReviewedAt, null);
    assert.equal(projection.hasPriorReviewHistory, false);
    assert.equal(projection.isReturnAfterGap, false);
    assert.equal(projection.returnGapHours, null);
    assert.equal(projection.returnGapDays, null);
    assert.equal(projection.daysSinceLastReview, null);
    assert.equal(projection.rescueCandidate, null);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
