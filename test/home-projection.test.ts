import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { GetHomeProjectionService } from "../src/core/orchestration/get-home-projection";
import { ReviewService } from "../src/core/orchestration/review-service";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("GetHomeProjectionService suggests rescue when a rescue candidate exists", () => {
  const dbPath = tempDbPath("home-projection-rescue");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);
    const home = new GetHomeProjectionService(db);

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

    const projection = home.getProjection("2026-03-12T12:00:00.000Z");

    assert.equal(projection.entryKind, "return_rescue");
    assert.equal(projection.focusWord, "luminous");
    assert.equal(projection.focusReason, "rescue");
    assert.equal(projection.suggestedNextAction, "rescue");
    assert.equal(projection.canStopAfterPrimaryAction, true);
    assert.equal(projection.optionalNextAction, "review");
    assert.equal(projection.isReturnAfterGap, true);
    assert.equal(projection.returnGapDays, 11);
    assert.ok(projection.rescueCandidate);
    assert.equal(projection.rescueCandidate.card.lemma, "luminous");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("GetHomeProjectionService suggests capture when there is no backlog yet", () => {
  const dbPath = tempDbPath("home-projection-capture");
  const db = openDatabase(dbPath);

  try {
    const home = new GetHomeProjectionService(db);
    const projection = home.getProjection("2026-03-12T12:00:00.000Z");

    assert.equal(projection.dueCount, 0);
    assert.equal(projection.entryKind, "capture");
    assert.equal(projection.hasPriorReviewHistory, false);
    assert.equal(projection.isReturnAfterGap, false);
    assert.equal(projection.suggestedNextAction, "capture");
    assert.equal(projection.canStopAfterPrimaryAction, false);
    assert.equal(projection.optionalNextAction, null);
    assert.equal(projection.focusWord, null);
    assert.equal(projection.focusReason, null);
    assert.equal(projection.rescueCandidate, null);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
