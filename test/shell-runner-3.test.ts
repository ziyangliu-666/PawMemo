import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellRunner } from "../src/cli/shell-runner";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
import type {
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse
} from "../src/llm/types";
import { nowIso } from "../src/lib/time";
import { AppSettingsRepository } from "../src/storage/repositories/app-settings-repository";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

class FakeShellTerminal {
  readonly writes: string[] = [];

  constructor(private readonly inputs: string[]) {}

  write(text: string): void {
    this.writes.push(text);
  }

  async prompt(promptText: string): Promise<string> {
    this.writes.push(promptText);
    return this.inputs.shift() ?? "/quit";
  }

  close(): void {}
}

test("ShellRunner accepts natural-language card workspace actions", async () => {
  const dbPath = tempDbPath("shell-natural-cards");
  const db = openDatabase(dbPath);

  try {
    const provider: LlmProvider = {
      name: "gemini",
      async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
        if (/shell companion voice-bank templates/i.test(request.systemInstruction)) {
          return {
            text: JSON.stringify({
              status_snapshot: "I'm still here, so we can start small."
            })
          };
        }

        if (/shell planner/i.test(request.systemInstruction)) {
          const prompt = request.userPrompt;

          if (/Current user input: 列出所有卡片呢/i.test(prompt)) {
            return {
              text: JSON.stringify({
                kind: "card",
                operation: "list"
              })
            };
          }

          if (/Current user input: show me luminous's cards/i.test(prompt)) {
            return {
              text: JSON.stringify({
                kind: "card",
                operation: "list",
                word: "luminous"
              })
            };
          }

          if (/Current user input: pause the cloze card for luminous/i.test(prompt)) {
            return {
              text: JSON.stringify({
                kind: "card",
                operation: "pause",
                word: "luminous",
                cardType: "cloze"
              })
            };
          }

          if (/Current user input: change card 1 answer to 发光的/i.test(prompt)) {
            return {
              text: JSON.stringify({
                kind: "card",
                operation: "update",
                cardId: 1,
                answer: "发光的"
              })
            };
          }

          if (/Current user input: delete card 1/i.test(prompt)) {
            return {
              text: JSON.stringify({
                kind: "card",
                operation: "delete",
                cardId: 1
              })
            };
          }
        }

        return {
          text: JSON.stringify({
            kind: "reply",
            message: "我是 PawMemo 的学习 shell。"
          })
        };
      },
      async listModels(): Promise<never[]> {
        return [];
      }
    };

    const capture = new CaptureWordService(db);
    const settings = new AppSettingsRepository(db);
    settings.setStoredApiKey("gemini", "test-key", nowIso("2026-03-15T10:00:00.000Z"));
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-15T10:00:00.000Z"
    });

    const terminal = new FakeShellTerminal([
      "列出所有卡片呢",
      "show me luminous's cards",
      "pause the cloze card for luminous",
      "show me luminous's cards",
      "change card 1 answer to 发光的",
      "delete card 1",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => provider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("I found 2 cards in the workspace")),
      "expected the shell to support planner-driven broad card lists without forcing a word clarification"
    );

    const rows = db
      .prepare(
        `
          SELECT sc.id, sc.answer_text, sc.lifecycle_state
          FROM study_card sc
          ORDER BY sc.id ASC
        `
      )
      .all() as Array<{ id: number; answer_text: string; lifecycle_state: string }>;

    assert.deepEqual(rows, [
      {
        id: 2,
        answer_text: "luminous\nMeaning: emitting light",
        lifecycle_state: "paused"
      }
    ]);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner supports direct /cards workspace commands", async () => {
  const dbPath = tempDbPath("shell-slash-cards");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-15T10:00:00.000Z"
    });

    const terminal = new FakeShellTerminal([
      '/cards create luminous usage --prompt "Use luminous in a sentence." --answer "The lake looked luminous at dawn."',
      '/cards update luminous:usage --answer "The clouds looked luminous at dawn."',
      "/cards archive luminous:usage",
      "/cards luminous",
      "/cards delete luminous:usage",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('I added card #3 for "luminous".')),
      "expected /cards create to add a new card"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I updated card #3 for "luminous".')),
      "expected /cards update to mutate a word-scoped selector"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I archived card #3 for "luminous".')),
      "expected /cards archive to change lifecycle state"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("#3 luminous · usage · archived")),
      "expected /cards list to show the archived card state"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I deleted card #3 for "luminous".')),
      "expected /cards delete to remove the targeted card"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner shows planner setup guidance when no API key is configured", async () => {
  const dbPath = tempDbPath("shell-planner-guidance");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  const priorGoogleApiKey = process.env.GOOGLE_API_KEY;
  const priorOpenAiApiKey = process.env.OPENAI_API_KEY;
  const priorAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const terminal = new FakeShellTerminal(["hi", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => {
        throw new Error("provider should not be constructed without an API key");
      }
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("I'm here, even before the live model is set up.")),
      "expected warm no-model guidance when planner configuration is missing"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Start with one word through `/capture ...`, or open `/help` for a quick tour.")),
      "expected local action guidance when planner configuration is missing"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Use `/models` when you want free chat, ask, and teach to wake up.")),
      "expected model setup guidance when planner configuration is missing"
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

    if (priorOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = priorOpenAiApiKey;
    }

    if (priorAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = priorAnthropicApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
