import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LlmShellPlanner,
  normalizeShellPlannerPayload
} from "../src/cli/shell-planner";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "../src/llm/types";
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
        romanceMode: "off",
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
          romanceMode: "off",
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
