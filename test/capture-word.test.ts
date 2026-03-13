import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { DuplicateEncounterError } from "../src/lib/errors";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("CaptureWordService stores lexeme, encounter, mastery, and cards", () => {
  const dbPath = tempDbPath("capture");
  const db = openDatabase(dbPath);

  try {
    const service = new CaptureWordService(db);
    const result = service.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      sourceLabel: "marine article",
      capturedAt: "2026-03-12T10:00:00.000Z"
    });

    assert.equal(result.lexeme.normalized, "luminous");
    assert.equal(result.sense.gloss, "emitting light");
    assert.equal(result.encounter.sourceLabel, "marine article");
    assert.equal(result.mastery.state, "seen");
    assert.equal(result.cards.length, 2);

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM word_encounters) AS encounter_count,
            (SELECT COUNT(*) FROM word_mastery) AS mastery_count,
            (SELECT COUNT(*) FROM review_cards) AS card_count,
            (SELECT COUNT(*) FROM event_log) AS event_count
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 1);
    assert.equal(counts.encounter_count, 1);
    assert.equal(counts.mastery_count, 1);
    assert.equal(counts.card_count, 2);
    assert.equal(counts.event_count, 1);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("CaptureWordService rejects duplicate encounters for the same word and context", () => {
  const dbPath = tempDbPath("duplicate");
  const db = openDatabase(dbPath);

  try {
    const service = new CaptureWordService(db);

    service.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T10:00:00.000Z"
    });

    assert.throws(
      () =>
        service.capture({
          word: "luminous",
          context: "The jellyfish gave off a luminous glow.",
          gloss: "emitting light",
          capturedAt: "2026-03-12T10:01:00.000Z"
        }),
      DuplicateEncounterError
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
