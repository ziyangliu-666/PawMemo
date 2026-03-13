import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReviewSessionRunner } from "../src/cli/review-session-runner";
import type { StudyCellIntent } from "../src/cli/transcript-intent";
import type { CliDataKind } from "../src/cli/theme";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeTerminal {
  readonly writes: string[] = [];

  constructor(private readonly inputs: string[]) {}

  write(text: string): void {
    this.writes.push(text);
  }

  async prompt(promptText: string): Promise<string> {
    this.writes.push(promptText);
    return this.inputs.shift() ?? "";
  }

  close(): void {}
}

class StructuredFakeTerminal extends FakeTerminal {
  readonly dataBlocks: Array<{
    text: string;
    kind: CliDataKind;
    intent?: StudyCellIntent;
  }> = [];

  writeDataBlock(text: string, kind: CliDataKind, intent?: StudyCellIntent): void {
    this.dataBlocks.push({ text, kind, intent });
  }
}

test("ReviewSessionRunner grades one card and stops at the session limit", async () => {
  const dbPath = tempDbPath("review-session-runner-limit");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const terminal = new FakeTerminal(["", "g"]);
    const session = ReviewSessionRunner.withTerminal(db, terminal);

    const result = await session.run({
      limit: 1,
      now: "2026-03-12T12:00:00.000Z"
    });

    assert.equal(result.reviewedCount, 1);
    assert.equal(result.quitEarly, false);
    assert.equal(result.limitReached, true);
    assert.deepEqual(result.gradeCounts, {
      again: 0,
      hard: 0,
      good: 1,
      easy: 0
    });
    assert.ok(
      terminal.writes.some((line) => line.includes("Saved good.")),
      "expected a saved-grade confirmation in session output"
    );

    const dueRows = db
      .prepare("SELECT COUNT(*) AS count FROM review_cards WHERE due_at <= ?")
      .get("2026-03-12T12:00:00.000Z") as { count: number };

    assert.equal(dueRows.count, 1);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ReviewSessionRunner can quit before reveal without grading", async () => {
  const dbPath = tempDbPath("review-session-runner-quit");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const terminal = new FakeTerminal(["q"]);
    const session = ReviewSessionRunner.withTerminal(db, terminal);

    const result = await session.run({
      now: "2026-03-12T12:00:00.000Z"
    });

    assert.equal(result.reviewedCount, 0);
    assert.equal(result.quitEarly, true);
    assert.equal(result.limitReached, false);
    assert.deepEqual(result.gradeCounts, {
      again: 0,
      hard: 0,
      good: 0,
      easy: 0
    });

    const reviewedCount = db
      .prepare("SELECT COUNT(*) AS count FROM review_history")
      .get() as { count: number };

    assert.equal(reviewedCount.count, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ReviewSessionRunner preserves structured study intent for review transcript output", async () => {
  const dbPath = tempDbPath("review-session-runner-intent");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const terminal = new StructuredFakeTerminal(["", "g"]);
    const session = ReviewSessionRunner.withTerminal(db, terminal);

    await session.run({
      limit: 1,
      now: "2026-03-12T12:00:00.000Z"
    });

    assert.ok(
      terminal.dataBlocks.some(
        (entry) =>
          entry.kind === "review-card-heading" &&
          entry.intent?.kind === "review-card" &&
          entry.text.includes("luminous")
      )
    );
    assert.ok(
      terminal.dataBlocks.some(
        (entry) =>
          entry.kind === "plain" &&
          entry.intent?.kind === "review-card" &&
          entry.text.length > 0
      )
    );
    assert.ok(
      terminal.dataBlocks.some(
        (entry) =>
          entry.kind === "review-session-status-success" &&
          entry.intent?.kind === "review-summary"
      )
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
