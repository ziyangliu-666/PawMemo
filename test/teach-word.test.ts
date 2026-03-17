import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TeachWordService } from "../src/core/orchestration/teach-word";
import { CardAuthorContractError, ExplanationContractError } from "../src/lib/errors";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "../src/llm/types";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeGeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  requests: LlmTextRequest[] = [];
  responseQueue = [
    JSON.stringify({
      gloss: "emitting light",
      explanation: "Here it describes the glow as giving off light.",
      usage_note: "It is often used for things that seem to shine.",
      example: "The lantern gave off a luminous glow.",
      highlights: ["giving off light", "things that seem to shine"],
      confidence_note: "This context makes the meaning clear."
    }),
    JSON.stringify({
      status: "ok",
      reason: "",
      normalized_context: "The jellyfish gave off a luminous glow.",
      cloze_context: "The jellyfish gave off a ____ glow."
    })
  ];

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.requests.push(request);
    const nextResponse = this.responseQueue.shift();

    return {
      text:
        nextResponse ??
        JSON.stringify({
          status: "clarify",
          reason: "No fake response queued.",
          normalized_context: "",
          cloze_context: ""
        })
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
    assert.equal(
      result.capture.sense.exampleContext,
      "The jellyfish gave off a luminous glow."
    );
    assert.equal(
      result.capture.cards[1]?.promptText,
      "Fill the missing word.\nThe jellyfish gave off a ____ glow."
    );

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM word_encounters) AS encounter_count,
            (SELECT COUNT(*) FROM study_card) AS card_count,
            (SELECT COUNT(*) FROM event_log WHERE event_type = 'word.taught') AS taught_events
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 1);
    assert.equal(counts.encounter_count, 1);
    assert.equal(counts.card_count, 2);
    assert.equal(counts.taught_events, 1);
    assert.equal(fakeProvider.requests.length, 2);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("TeachWordService can draft study cards before persistence", async () => {
  const dbPath = tempDbPath("teach-draft");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    const teach = new TeachWordService(db, () => fakeProvider);
    const draft = await teach.draft({
      word: "luminous",
      context: "加入 luminous",
      apiKey: "test-key"
    });

    assert.equal(draft.status, "ready");
    assert.equal(draft.ask.gloss, "emitting light");
    if (draft.status !== "ready") {
      assert.fail("expected a ready teach draft");
    }
    assert.equal(draft.draft.normalizedContext, "The jellyfish gave off a luminous glow.");
    assert.equal(draft.draft.cards.length, 2);

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM study_card) AS card_count
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 0);
    assert.equal(counts.card_count, 0);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("TeachWordService returns a clarification draft outcome when card authoring needs a cleaner example", async () => {
  const dbPath = tempDbPath("teach-draft-clarify");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseQueue = [
      JSON.stringify({
        gloss: "尖塔",
        explanation: "这里指建筑顶部细长尖起的塔尖。",
        usage_note: "常见于教堂或古典建筑。",
        example: "The church spire stood above the town.",
        highlights: ["建筑顶部", "细长尖起的塔尖"],
        confidence_note: "这个词本身足够明确。"
      }),
      JSON.stringify({
        status: "clarify",
        reason: "The raw context is just a save command.",
        normalized_context: "",
        cloze_context: ""
      })
    ];

    const teach = new TeachWordService(db, () => fakeProvider);
    const draft = await teach.draft({
      word: "spire",
      context: "i want to learn spire",
      apiKey: "test-key"
    });

    assert.equal(draft.status, "needs_clarification");
    assert.equal(draft.ask.gloss, "尖塔");
    if (draft.status !== "needs_clarification") {
      assert.fail("expected a clarification teach draft outcome");
    }
    assert.match(draft.reason, /save command/i);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("TeachWordService keeps card-shell wording aligned with the current utterance language", async () => {
  const dbPath = tempDbPath("teach-zh-shell");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseQueue = [
      JSON.stringify({
        gloss: "清晰易懂的",
        explanation: "这里表示这个解释很容易理解。",
        usage_note: "常用于描述表达或说明是否清楚。",
        example: "她的解释一直都很 lucid。",
        highlights: ["很容易理解", "表达或说明"],
        confidence_note: "这个语境足够明确。"
      }),
      JSON.stringify({
        status: "ok",
        reason: "",
        normalized_context: "Her explanation was lucid and easy to follow.",
        cloze_context: "Her explanation was ____ and easy to follow."
      })
    ];

    const teach = new TeachWordService(db, () => fakeProvider);
    const result = await teach.teach({
      word: "lucid",
      context: "加入 lucid",
      apiKey: "test-key"
    });

    assert.equal(
      result.capture.cards[0]?.promptText,
      "这里的“lucid”是什么意思？\nHer explanation was lucid and easy to follow."
    );
    assert.equal(
      result.capture.cards[1]?.promptText,
      "填空。\nHer explanation was ____ and easy to follow."
    );
    assert.equal(result.capture.cards[1]?.answerText, "lucid\n意思：清晰易懂的");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("TeachWordService can build a definition-style draft when the caller requests it explicitly", async () => {
  const dbPath = tempDbPath("teach-definition-mode");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseQueue = [
      JSON.stringify({
        gloss: "尖塔",
        explanation: "这里指建筑顶部细长尖起的塔尖。",
        usage_note: "常见于教堂或古典建筑。",
        example: "The church spire stood above the town.",
        highlights: ["建筑顶部", "细长尖起的塔尖"],
        confidence_note: "这个词本身足够明确。"
      })
    ];

    const teach = new TeachWordService(db, () => fakeProvider);
    const result = await teach.teach({
      word: "spire",
      context: "i want to learn spire",
      studyContextMode: "definition",
      apiKey: "test-key"
    });

    assert.equal(result.capture.sense.exampleContext, "Spire means 尖塔.");
    assert.equal(result.capture.cards.length, 1);
    assert.equal(
      result.capture.cards[0]?.promptText,
      "Fill the missing word.\n____ means 尖塔."
    );
    assert.equal(result.capture.cards[0]?.cardType, "cloze");
    assert.equal(fakeProvider.requests.length, 1);
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
    fakeProvider.responseQueue = [
      JSON.stringify({
      gloss: "   ",
      explanation: "Here it describes the glow as giving off light.",
      usage_note: "Used for things that shine.",
      confidence_note: "The context makes the meaning clear."
      })
    ];

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
            (SELECT COUNT(*) FROM study_card) AS card_count
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

test("TeachWordService rejects card-author output that cannot produce a clean study card", async () => {
  const dbPath = tempDbPath("teach-invalid-card-author");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    fakeProvider.responseQueue = [
      JSON.stringify({
        gloss: "someone who makes a process easier",
        explanation: "Here it names the person guiding the process.",
        usage_note: "It often refers to a person helping a group move forward.",
        confidence_note: "The intended meaning depends on the surrounding process."
      }),
      JSON.stringify({
        status: "ok",
        reason: "",
        normalized_context: "The facilitator kept the discussion moving smoothly.",
        cloze_context: "The ____ kept the ____ moving smoothly."
      })
    ];

    const teach = new TeachWordService(db, () => fakeProvider);

    await assert.rejects(
      () =>
        teach.teach({
          word: "facilitator",
          context: "handle invalid responses, facilitator",
          apiKey: "test-key"
        }),
      (error: unknown) =>
        error instanceof CardAuthorContractError &&
        /usable study context/.test(error.message)
    );

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM word_encounters) AS encounter_count,
            (SELECT COUNT(*) FROM study_card) AS card_count
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
