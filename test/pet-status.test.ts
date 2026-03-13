import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { GetCompanionSignalsService } from "../src/core/orchestration/get-companion-signals";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("GetCompanionSignalsService returns due count and most recent word", () => {
  const dbPath = tempDbPath("pet-status");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const service = new GetCompanionSignalsService(db);
    const result = service.getSignals("2026-03-12T12:00:00.000Z");

    assert.equal(result.dueCount, 2);
    assert.equal(result.recentWord, "luminous");
    assert.equal(result.stableCount, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
