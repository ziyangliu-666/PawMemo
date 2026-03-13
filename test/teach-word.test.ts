import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TeachWordService } from "../src/core/orchestration/teach-word";
import { ExplanationContractError } from "../src/lib/errors";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "../src/llm/types";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeGeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  lastRequest: LlmTextRequest | null = null;
  responseText = JSON.stringify({
    gloss: "emitting light",
    explanation: "Here it describes the glow as giving off light.",
    usage_note: "It is often used for things that seem to shine.",
    confidence_note: "This context makes the meaning clear."
  });

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.lastRequest = request;

    return {
      text: this.responseText
    };
  }

  async listModels(): Promise<never[]> {
    return [];
  }
}

test("TeachWordService composes ask plus capture into persisted learning state", async () => {
  const dbPath = tempDbPath("teach");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    const teach = new TeachWordService(db, () => fakeProvider);
    const result = await teach.teach({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      sourceLabel: "article",
      apiKey: "test-key"
    });

    assert.equal(result.ask.gloss, "emitting light");
    assert.equal(result.capture.sense.gloss, "emitting light");
    assert.equal(result.capture.encounter.sourceLabel, "article");
    assert.equal(result.capture.cards.length, 2);

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM word_encounters) AS encounter_count,
            (SELECT COUNT(*) FROM review_cards) AS card_count,
            (SELECT COUNT(*) FROM event_log WHERE event_type = 'word.taught') AS taught_events
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 1);
    assert.equal(counts.encounter_count, 1);
    assert.equal(counts.card_count, 2);
    assert.equal(counts.taught_events, 1);
    assert.ok(fakeProvider.lastRequest);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("TeachWordService rejects explanation output without a usable provider gloss", async () => {
  const dbPath = tempDbPath("teach-invalid-gloss");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseText = JSON.stringify({
      gloss: "   ",
      explanation: "Here it describes the glow as giving off light.",
      usage_note: "Used for things that shine.",
      confidence_note: "The context makes the meaning clear."
    });

    const teach = new TeachWordService(db, () => fakeProvider);

    await assert.rejects(
      () =>
        teach.teach({
          word: "luminous",
          context: "The jellyfish gave off a luminous glow.",
          apiKey: "test-key"
        }),
      (error: unknown) =>
        error instanceof ExplanationContractError &&
        /usable gloss/.test(error.message)
    );

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM word_encounters) AS encounter_count,
            (SELECT COUNT(*) FROM review_cards) AS card_count
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 0);
    assert.equal(counts.encounter_count, 0);
    assert.equal(counts.card_count, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
