import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AskWordService } from "../src/core/orchestration/ask-word";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
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
    usage_note: "It is often used for light, color, or writing that seems to shine.",
    confidence_note: "The core meaning is stable, and this context confirms it clearly."
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

test("AskWordService uses stored settings and retrieved word knowledge in the provider request", async () => {
  const dbPath = tempDbPath("ask");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "giving off light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    db.prepare(
      `
        UPDATE app_settings
        SET value = 'gemini-2.5-flash'
        WHERE key = 'llm.model'
      `
    ).run();

    const fakeProvider = new FakeGeminiProvider();
    const ask = new AskWordService(db, () => fakeProvider);
    const result = await ask.ask({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      apiKey: "test-key"
    });

    assert.equal(result.word, "luminous");
    assert.equal(result.gloss, "emitting light");
    assert.equal(result.knownWord, true);
    assert.equal(result.knownState, "seen");
    assert.equal(result.retrievedGloss, "giving off light");
    assert.equal(result.provider, "gemini");
    assert.equal(result.model, "gemini-2.5-flash");
    assert.ok(fakeProvider.lastRequest);
    assert.match(fakeProvider.lastRequest?.userPrompt ?? "", /Known gloss in PawMemo: giving off light/);
    assert.match(fakeProvider.lastRequest?.userPrompt ?? "", /Stored contexts for this word:/);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("AskWordService falls back to configured provider defaults for unknown words", async () => {
  const dbPath = tempDbPath("ask-new");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    const ask = new AskWordService(db, () => fakeProvider);
    const result = await ask.ask({
      word: "brisk",
      context: "We took a brisk walk before sunrise.",
      apiKey: "test-key"
    });

    assert.equal(result.knownWord, false);
    assert.equal(result.knownState, null);
    assert.equal(result.retrievedGloss, null);
    assert.equal(result.provider, "gemini");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("AskWordService uses the stored API key when no explicit or env key is present", async () => {
  const dbPath = tempDbPath("ask-stored-key");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  const priorGoogleApiKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    db.prepare(
      `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ('llm.api_key.gemini', 'stored-test-key', '2026-03-12T00:00:00.000Z')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `
    ).run();

    const fakeProvider = new FakeGeminiProvider();
    const ask = new AskWordService(db, () => fakeProvider);
    await ask.ask({
      word: "brisk",
      context: "We took a brisk walk before sunrise."
    });

    assert.equal(fakeProvider.lastRequest?.apiKey, "stored-test-key");
  } finally {
    if (priorApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = priorApiKey;
    }

    if (priorGoogleApiKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = priorGoogleApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("AskWordService falls back to the stored gloss and strips unsupported memory claims", async () => {
  const dbPath = tempDbPath("ask-hardened");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "giving off light",
      capturedAt: "2026-03-12T00:00:00.000Z"
    });

    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseText = [
      "```json",
      JSON.stringify({
        gloss: "   ",
        explanation:
          "I remember you learned this one before. Here it means that the glow gives off light.",
        usage_note: "  Often used for light or writing that seems to shine.  ",
        confidence_note: "This reading depends mostly on the sentence, not on any fake memory."
      }),
      "```"
    ].join("\n");

    const ask = new AskWordService(db, () => fakeProvider);
    const result = await ask.ask({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      apiKey: "test-key"
    });

    assert.equal(result.gloss, "giving off light");
    assert.equal(result.retrievedGloss, "giving off light");
    assert.doesNotMatch(result.explanation, /I remember/i);
    assert.match(result.explanation, /gives off light/i);
    assert.equal(
      result.usageNote,
      "Often used for light or writing that seems to shine."
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
