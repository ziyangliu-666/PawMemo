import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { StudyServices } from "../src/core/orchestration/study-services";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "../src/llm/types";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeGeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  lastRequest: LlmTextRequest | null = null;
  responseQueue = [
    JSON.stringify({
      gloss: "emitting light",
      explanation: "Here it means that something gives off light.",
      usage_note: "Often used for things that seem to shine.",
      example: "The jellyfish looked luminous in the dark water.",
      highlights: ["gives off light", "things that seem to shine"],
      confidence_note: "The sentence makes the meaning clear."
    })
  ];

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.lastRequest = request;
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

test("StudyServices exposes capture, review, and signals through one stable boundary", () => {
  const dbPath = tempDbPath("study-services-core");
  const db = openDatabase(dbPath);

  try {
    const study = new StudyServices(db);

    const capture = study.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-12T09:00:00.000Z"
    });

    assert.equal(capture.cards.length, 2);

    const queue = study.getReviewQueue({
      now: "2026-03-12T09:00:00.000Z"
    });
    assert.equal(queue.totalDue, 2);

    const next = study.getNextReviewCard("2026-03-12T09:00:00.000Z");
    assert.ok(next);
    assert.equal(next.lemma, "luminous");

    const reveal = study.revealReviewCard(next.id);
    assert.match(reveal.card.answerText, /emitting light/i);

    const grade = study.gradeReviewCard({
      cardId: next.id,
      grade: "good",
      reviewedAt: "2026-03-12T10:00:00.000Z"
    });
    assert.equal(grade.mastery.state, "familiar");
    assert.equal(grade.card.state, "review");

    const signals = study.getCompanionSignals("2026-03-12T12:00:00.000Z");
    assert.equal(signals.dueCount, 1);
    assert.equal(signals.dueNewCount, 1);
    assert.equal(signals.dueReviewCount, 0);
    assert.equal(signals.todayReviewedCount, 1);
    assert.equal(signals.recentWord, "luminous");

    const recovery = study.getRecoveryProjection("2026-03-12T12:00:00.000Z");
    assert.equal(recovery.lastReviewedAt, "2026-03-12T10:00:00.000Z");
    assert.equal(recovery.hasPriorReviewHistory, true);
    assert.equal(recovery.isReturnAfterGap, false);
    assert.equal(recovery.rescueCandidate, null);

    const home = study.getHomeProjection("2026-03-12T12:00:00.000Z");
    assert.equal(home.entryKind, "review");
    assert.equal(home.focusWord, "luminous");
    assert.equal(home.focusReason, "recent");
    assert.equal(home.suggestedNextAction, "review");
    assert.equal(home.canStopAfterPrimaryAction, false);
    assert.equal(home.recentWord, "luminous");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("StudyServices routes ask and teach through the same provider-backed study boundary", async () => {
  const dbPath = tempDbPath("study-services-llm");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    const study = new StudyServices(db, () => fakeProvider);

    const ask = await study.ask({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      apiKey: "test-key"
    });

    assert.equal(ask.gloss, "emitting light");
    assert.equal(ask.example, "The jellyfish looked luminous in the dark water.");
    assert.deepEqual(ask.highlights, [
      "gives off light",
      "things that seem to shine"
    ]);
    assert.equal(ask.knownWord, false);
    assert.match(fakeProvider.lastRequest?.userPrompt ?? "", /luminous/i);
    assert.match(
      fakeProvider.lastRequest?.systemInstruction ?? "",
      /example, highlights, confidence_note/i
    );

    fakeProvider.responseQueue = [
      JSON.stringify({
        gloss: "clear and easy to understand",
        explanation: "Here it means the explanation is easy to follow.",
        usage_note: "Often used for speech or writing that is easy to grasp.",
        example: "Her explanation stayed lucid from start to finish.",
        highlights: ["easy to follow", "speech or writing"],
        confidence_note: "The context strongly supports this meaning."
      }),
      JSON.stringify({
        status: "ok",
        reason: "",
        normalized_context: "Her explanation was lucid and easy to follow.",
        cloze_context: "Her explanation was ____ and easy to follow."
      })
    ];

    const teach = await study.teach({
      word: "lucid",
      context: "Her explanation was lucid and easy to follow.",
      apiKey: "test-key"
    });

    assert.equal(teach.ask.gloss, "clear and easy to understand");
    assert.equal(teach.capture.lexeme.lemma, "lucid");
    assert.equal(teach.capture.cards.length, 2);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("StudyServices asks for Chinese learner-facing explanation fields when the request is Chinese", async () => {
  const dbPath = tempDbPath("study-services-ask-zh");
  const db = openDatabase(dbPath);

  try {
    const fakeProvider = new FakeGeminiProvider();
    const study = new StudyServices(db, () => fakeProvider);

    await study.ask({
      word: "slay",
      context: "解释一下什么是 slay",
      apiKey: "test-key"
    });

    assert.match(
      fakeProvider.lastRequest?.userPrompt ?? "",
      /Learner-facing response language: zh/
    );
    assert.match(
      fakeProvider.lastRequest?.systemInstruction ?? "",
      /natural Chinese/i
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
