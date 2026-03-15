import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CardWorkspaceService } from "../src/core/orchestration/card-workspace-service";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { ReviewService } from "../src/core/orchestration/review-service";
import { CardSelectionError } from "../src/lib/errors";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("CardWorkspaceService can create update pause resume archive and delete cards", () => {
  const dbPath = tempDbPath("card-workspace");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);
    const workspace = new CardWorkspaceService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-15T10:00:00.000Z"
    });

    const created = workspace.execute({
      kind: "create",
      input: {
        word: "luminous",
        cardType: "usage",
        promptText: "Use luminous in a sentence.",
        answerText: "The lake looked luminous at dawn."
      }
    });

    assert.equal(created.kind, "create");
    assert.equal(created.card.cardType, "usage");
    assert.equal(created.card.lifecycleState, "active");

    const updated = workspace.execute({
      kind: "update",
      input: {
        selector: { cardId: created.card.id },
        answerText: "The clouds looked luminous at dawn."
      }
    });

    assert.equal(updated.kind, "update");
    assert.equal(updated.card.answerText, "The clouds looked luminous at dawn.");

    const paused = workspace.execute({
      kind: "set-lifecycle",
      input: {
        selector: { cardId: created.card.id },
        lifecycleState: "paused"
      }
    });

    assert.equal(paused.kind, "set-lifecycle");
    assert.equal(paused.card.lifecycleState, "paused");
    assert.ok(
      review.getQueue({ limit: 10 }).items.every((card) => card.id !== created.card.id),
      "expected paused cards to stay out of the due queue"
    );

    const resumed = workspace.execute({
      kind: "set-lifecycle",
      input: {
        selector: { cardId: created.card.id },
        lifecycleState: "active"
      }
    });

    assert.equal(resumed.kind, "set-lifecycle");
    assert.equal(resumed.card.lifecycleState, "active");
    assert.ok(
      review.getQueue({ limit: 10 }).items.some((card) => card.id === created.card.id),
      "expected resumed cards to re-enter the active due queue"
    );

    const archived = workspace.execute({
      kind: "set-lifecycle",
      input: {
        selector: { cardId: created.card.id },
        lifecycleState: "archived"
      }
    });

    assert.equal(archived.kind, "set-lifecycle");
    assert.equal(archived.card.lifecycleState, "archived");

    const deleted = workspace.execute({
      kind: "delete",
      input: {
        selector: { cardId: created.card.id }
      }
    });

    assert.equal(deleted.kind, "delete");
    assert.equal(deleted.card.id, created.card.id);
    assert.equal(
      workspace.listCards({
        word: "luminous",
        lifecycleStates: ["active", "paused", "archived"],
        limit: 10
      }).cards.some((card) => card.id === created.card.id),
      false
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("CardWorkspaceService raises a selection error when a word has multiple cards", () => {
  const dbPath = tempDbPath("card-workspace-ambiguous");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const workspace = new CardWorkspaceService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-15T10:00:00.000Z"
    });

    assert.throws(
      () =>
        workspace.execute({
          kind: "update",
          input: {
            selector: { word: "luminous" },
            answerText: "bright"
          }
        }),
      (error: unknown) =>
        error instanceof CardSelectionError &&
        error.candidates.length === 2 &&
        error.selector === "luminous"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
