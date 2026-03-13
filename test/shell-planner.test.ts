import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildShellPlannerPrompt
} from "../src/llm/shell-planner-prompt";
import {
  LlmShellPlanner,
  normalizeShellPlannerPayload
} from "../src/cli/shell-planner";
import type {
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
  LlmTextStreamRequest
} from "../src/llm/types";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakePlannerProvider implements LlmProvider {
  readonly name = "gemini" as const;
  lastRequest: LlmTextRequest | null = null;

  constructor(private readonly responseText: string) {}

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

class FakeStreamingPlannerProvider extends FakePlannerProvider {
  streamCalls = 0;

  async generateTextStream(
    request: LlmTextStreamRequest
  ): Promise<LlmTextResponse> {
    this.streamCalls += 1;
    this.lastRequest = request;

    for (const chunk of ['{"kind":"reply","message":"', "你好，", "我是", ' PawMemo。"}']) {
      await request.onTextDelta(chunk);
    }

    return {
      text: '{"kind":"reply","message":"你好，我是 PawMemo。"}'
    };
  }
}

test("normalizeShellPlannerPayload maps reply output", () => {
  const result = normalizeShellPlannerPayload({
    kind: "reply",
    message: "先把词给我，我来解释。"
  });

  assert.deepEqual(result, {
    kind: "reply",
    mood: "curious",
    message: "先把词给我，我来解释。"
  });
});

test("normalizeShellPlannerPayload maps teach output with confirmation text", () => {
  const result = normalizeShellPlannerPayload({
    kind: "teach",
    word: "luminous",
    context: "帮我记 luminous",
    message: "要我先把 luminous 加进学习计划吗？"
  });

  assert.deepEqual(result, {
    kind: "teach",
    input: {
      word: "luminous",
      context: "帮我记 luminous"
    },
    confirmationMessage: "要我先把 luminous 加进学习计划吗？"
  });
});

test("normalizeShellPlannerPayload maps rescue output", () => {
  const result = normalizeShellPlannerPayload({
    kind: "rescue"
  });

  assert.deepEqual(result, {
    kind: "rescue"
  });
});

test("normalizeShellPlannerPayload reuses raw input as fallback context", () => {
  const result = normalizeShellPlannerPayload(
    {
      kind: "capture",
      word: "luminous",
      gloss: "emitting light"
    },
    "remember luminous = emitting light"
  );

  assert.deepEqual(result, {
    kind: "capture",
    input: {
      word: "luminous",
      context: "remember luminous = emitting light",
      gloss: "emitting light"
    }
  });
});

test("normalizeShellPlannerPayload converts incomplete capture output into clarify", () => {
  const result = normalizeShellPlannerPayload(
    {
      kind: "capture",
      word: "luminous"
    },
    "remember luminous"
  );

  assert.deepEqual(result, {
    kind: "clarify",
    mood: "confused",
    message: "I caught the word, but I still need the meaning you want me to remember."
  });
});

test("normalizeShellPlannerPayload rejects reply output without a message", () => {
  assert.throws(
    () =>
      normalizeShellPlannerPayload({
        kind: "reply"
      }),
    /without a message/i
  );
});

test("buildShellPlannerPrompt layers structured companion prompt fields into planner input", () => {
  const prompt = buildShellPlannerPrompt({
    rawInput: "帮我解释 lucid",
    recentTurns: [
      {
        speaker: "user",
        kind: "message",
        contentText: "昨天我们在看 lucid",
        createdAt: "2026-03-13T10:00:00.000Z",
        payloadJson: null
      },
      {
        speaker: "assistant",
        kind: "message",
        contentText: "嗯，把词给我。",
        createdAt: "2026-03-13T10:00:05.000Z",
        payloadJson: null
      }
    ],
    activePack: {
      id: "mina",
      displayName: "Mina",
      styleLabel: "warm",
      romanceMode: "on",
      description: "A warm study companion.",
      personality: "Soft and attentive.",
      scenario: "Already sharing a quiet study nook.",
      exampleMessages: ["I'm here. We can do this together."],
      postHistoryInstructions: ["Continue the same ongoing scene after reading recent turns."],
      toneRules: ["Keep replies gently affectionate.", "Stay concise."],
      boundaryRules: ["Do not guilt the learner.", "Do not replace study help with romance."],
      avatarFrames: {},
      moodLines: {},
      reactions: {}
    },
    statusSignals: {
      dueCount: 2,
      recentWord: "lucid"
    },
    pendingProposalText: "Do you want me to save lucid first?"
  });

  assert.match(prompt.systemInstruction, /Companion description: A warm study companion\./);
  assert.match(prompt.systemInstruction, /Companion personality: Soft and attentive\./);
  assert.match(prompt.systemInstruction, /Current companion scenario: Already sharing a quiet study nook\./);
  assert.match(prompt.systemInstruction, /Companion tone rules:/);
  assert.match(prompt.systemInstruction, /Companion boundary rules:/);
  assert.match(prompt.systemInstruction, /occasionally end a short reply or clarification with one fitting kaomoji/i);
  assert.match(prompt.userPrompt, /Post-history instructions:/);
  assert.match(prompt.userPrompt, /Continue the same ongoing scene/);
  assert.match(prompt.userPrompt, /Example voice messages:/);
  assert.match(prompt.userPrompt, /I'm here\. We can do this together\./);
});

test("LlmShellPlanner uses the provider for chat planning when configured", async () => {
  const dbPath = tempDbPath("shell-planner");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const provider = new FakePlannerProvider(
      JSON.stringify({
        kind: "reply",
        message: "我是 PawMemo 的学习 shell。"
      })
    );
    const planner = new LlmShellPlanner(db, () => provider);
    const result = await planner.plan({
      rawInput: "这是啥",
      recentTurns: [],
      activePack: {
        id: "momo",
        displayName: "Momo",
        styleLabel: "loyal",
        romanceMode: "off",
        description: "A loyal study dog.",
        personality: "Calm and eager to help.",
        scenario: "Already sharing the study nook.",
        exampleMessages: ["I'm here with the word pile."],
        postHistoryInstructions: ["Stay in the current scene after reading history."],
        toneRules: ["Sound warm and steady."],
        boundaryRules: ["Do not overshadow study help."],
        avatarFrames: {},
        moodLines: {},
        reactions: {}
      },
      statusSignals: {
        dueCount: 0,
        recentWord: null
      }
    });

    assert.deepEqual(result, {
      kind: "reply",
      mood: "curious",
      message: "我是 PawMemo 的学习 shell。"
    });
    assert.match(provider.lastRequest?.userPrompt ?? "", /Current user input: 这是啥/);
    assert.match(provider.lastRequest?.systemInstruction ?? "", /Companion description: A loyal study dog\./);
    assert.match(provider.lastRequest?.userPrompt ?? "", /Example voice messages:/);
  } finally {
    if (priorApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = priorApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("LlmShellPlanner can surface streamed planner message deltas for reply turns", async () => {
  const dbPath = tempDbPath("shell-planner-stream");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const provider = new FakeStreamingPlannerProvider(
      '{"kind":"reply","message":"你好，我是 PawMemo。"}'
    );
    const planner = new LlmShellPlanner(db, () => provider);
    const streamed: string[] = [];
    const result = await planner.plan(
      {
        rawInput: "你好",
        recentTurns: [],
        activePack: {
          id: "momo",
          displayName: "Momo",
          styleLabel: "loyal",
          romanceMode: "off",
          description: "A loyal study dog.",
          personality: "Calm and eager to help.",
          scenario: "Already sharing the study nook.",
          exampleMessages: ["I'm here with the word pile."],
          postHistoryInstructions: ["Stay in the current scene after reading history."],
          toneRules: ["Sound warm and steady."],
          boundaryRules: ["Do not overshadow study help."],
          avatarFrames: {},
          moodLines: {},
          reactions: {}
        },
        statusSignals: {
          dueCount: 0,
          recentWord: null
        }
      },
      {
        onMessageDelta: (delta) => {
          streamed.push(delta);
        }
      }
    );

    assert.equal(provider.streamCalls, 1);
    assert.equal(streamed.join(""), "你好，我是 PawMemo。");
    assert.deepEqual(result, {
      kind: "reply",
      mood: "curious",
      message: "你好，我是 PawMemo。"
    });
  } finally {
    if (priorApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = priorApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("LlmShellPlanner fails when no API key is configured", async () => {
  const dbPath = tempDbPath("shell-planner-fallback");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  const priorGoogleApiKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

  try {
    const planner = new LlmShellPlanner(db, () => {
      throw new Error("provider should not be constructed without an API key");
    });
    await assert.rejects(() =>
      planner.plan({
        rawInput: "这是啥",
        recentTurns: [],
        activePack: {
          id: "momo",
          displayName: "Momo",
          styleLabel: "loyal",
          romanceMode: "off",
          description: "A loyal study dog.",
          personality: "Calm and eager to help.",
          scenario: "Already sharing the study nook.",
          exampleMessages: ["I'm here with the word pile."],
          postHistoryInstructions: ["Stay in the current scene after reading history."],
          toneRules: ["Sound warm and steady."],
          boundaryRules: ["Do not overshadow study help."],
          avatarFrames: {},
          moodLines: {},
          reactions: {}
        },
        statusSignals: {
          dueCount: 0,
          recentWord: null
        }
      })
    );
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
