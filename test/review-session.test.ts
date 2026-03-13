import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { ReviewService } from "../src/core/orchestration/review-service";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("ReviewService returns the first due card in session order", () => {
  const dbPath = tempDbPath("review-next");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const service = new ReviewService(db);
    const result = service.getNext("2026-03-12T12:00:00.000Z");

    assert.ok(result);
    assert.equal(result.id, 1);
    assert.equal(result.lemma, "luminous");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ReviewService returns the answer side without changing scheduling state", () => {
  const dbPath = tempDbPath("review-reveal");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const service = new ReviewService(db);
    const result = service.reveal(2);

    assert.equal(result.card.id, 2);
    assert.match(result.card.answerText, /luminous/);

    const row = db
      .prepare("SELECT state, due_at FROM review_cards WHERE id = 2")
      .get() as Record<string, string>;

    assert.equal(row.state, "new");
    assert.equal(row.due_at, "2026-03-12T00:00:00.000Z");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
