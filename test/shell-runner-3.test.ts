import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellRunner } from "../src/cli/shell-runner";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { ReviewService } from "../src/core/orchestration/review-service";
import type { LlmModelInfo } from "../src/core/domain/models";
import { ProviderRequestError } from "../src/lib/errors";
import type {
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
  LlmTextStreamRequest
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

class FakeStreamingShellTerminal extends FakeShellTerminal {
  readonly rawWrites: string[] = [];

  writeRaw(text: string): void {
    this.rawWrites.push(text);
  }
}

class FakeGeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  lastRequest: LlmTextRequest | null = null;
  streamCalls = 0;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.lastRequest = request;

    if (/shell companion voice-bank templates/i.test(request.systemInstruction)) {
      return {
        text: JSON.stringify({
          status_snapshot: "I'm still here, so we can start small.",
          idle_prompt: "Give me one honest word, and I'll keep it with me.",
          stats_summary: "You moved {{todayReviewedCount}} today. I was paying attention."
        })
      };
    }

    if (/shell planner/i.test(request.systemInstruction)) {
      const prompt = request.userPrompt;

      if (/Current user input: what does luminous mean\?/i.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "ask",
            word: "luminous",
            context: "what does luminous mean?"
          })
        };
      }

      if (/Current user input: 加入 luminous/.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "teach",
            word: "luminous",
            context: "加入 luminous",
            message:
              'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?'
          })
        };
      }

      if (/Current user input: 增加 spire 到库里/.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "teach",
            word: "spire",
            context: "增加 spire 到库里",
            message: "要我先把 spire 起草成可复习的卡片吗？"
          })
        };
      }

      if (/Current user input: i want to learning spire/i.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "teach",
            word: "spire",
            context: "i want to learning spire",
            message:
              'I spotted "spire" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?'
          })
        };
      }

      if (/Current user input: yes/i.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "confirm"
          })
        };
      }

      if (/Current user input: 记住 luminous = 发光的/.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "capture",
            word: "luminous",
            context: "记住 luminous = 发光的",
            gloss: "发光的"
          })
        };
      }

      if (/Current user input: 救一下/.test(prompt)) {
        return {
          text: JSON.stringify({
            kind: "rescue"
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

      return {
        text: JSON.stringify({
          kind: "reply",
          message: "我是 PawMemo 的学习 shell。"
        })
      };
    }

    if (/study-card author/i.test(request.systemInstruction)) {
      if (/Target word: luminous/i.test(request.userPrompt)) {
        return {
          text: JSON.stringify({
            status: "ok",
            reason: "",
            normalized_context: "The jellyfish gave off a luminous glow.",
            cloze_context: "The jellyfish gave off a ____ glow."
          })
        };
      }

      if (/Target word: lucid/i.test(request.userPrompt)) {
        return {
          text: JSON.stringify({
            status: "ok",
            reason: "",
            normalized_context: "Her explanation was lucid and easy to follow.",
            cloze_context: "Her explanation was ____ and easy to follow."
          })
        };
      }

      if (/Target word: spire/i.test(request.userPrompt)) {
        if (/Raw captured context: The church had a tall spire\./i.test(request.userPrompt)) {
          return {
            text: JSON.stringify({
              status: "ok",
              reason: "",
              normalized_context: "The church had a tall spire.",
              cloze_context: "The church had a tall ____."
            })
          };
        }

        return {
          text: JSON.stringify({
            status: "clarify",
            reason: "The raw context is just a save command.",
            normalized_context: "",
            cloze_context: ""
          })
        };
      }
    }

    return {
      text: JSON.stringify({
        gloss: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? "尖塔"
          : "emitting light",
        explanation: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? "这里指建筑顶部细长尖起的塔尖。"
          : "Here it describes something that gives off light.",
        usage_note: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? "常见于教堂或古典建筑。"
          : "Often used for light or glowing surfaces.",
        example: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? "The church spire stood above the town."
          : "The lantern looked luminous in the dark.",
        highlights: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? ["建筑顶部", "尖起的塔尖"]
          : ["gives off light", "glowing surfaces"],
        confidence_note: /Current user input: 增加 spire 到库里/i.test(request.userPrompt) ||
          /\bword:\s*spire\b/i.test(request.userPrompt)
          ? "这个词本身足够明确。"
          : "The phrasing is clear enough to explain directly."
      })
    };
  }

  async listModels(): Promise<
    Array<{
      id: string;
      provider: "gemini";
      displayName: string | null;
      createdAt: string | null;
      ownedBy: string | null;
    }>
  > {
    return [
      {
        id: "gemini-2.5-flash",
        provider: "gemini",
        displayName: "Gemini 2.5 Flash",
        createdAt: null,
        ownedBy: "google"
      },
      {
        id: "gemini-2.5-pro",
        provider: "gemini",
        displayName: "Gemini 2.5 Pro",
        createdAt: null,
        ownedBy: "google"
      }
    ];
  }

  async generateTextStream(request: LlmTextStreamRequest): Promise<LlmTextResponse> {
    this.streamCalls += 1;
    this.lastRequest = request;

    if (/shell planner/i.test(request.systemInstruction)) {
      if (
        /Current user input: what does luminous mean\?/i.test(request.userPrompt) ||
        /Current user input: 加入 luminous/.test(request.userPrompt) ||
        /Current user input: 增加 spire 到库里/.test(request.userPrompt) ||
        /Current user input: i want to learning spire/i.test(request.userPrompt) ||
        /Current user input: yes/i.test(request.userPrompt) ||
        /Current user input: 记住 luminous = 发光的/.test(request.userPrompt) ||
        /Current user input: 救一下/.test(request.userPrompt)
      ) {
        return this.generateText(request);
      }

      for (const chunk of ['{"kind":"reply","message":"', "我是", " PawMemo", ' 的学习 shell。"}']) {
        await request.onTextDelta(chunk);
      }

      return {
        text: JSON.stringify({
          kind: "reply",
          message: "我是 PawMemo 的学习 shell。"
        })
      };
    }

    return this.generateText(request);
  }
}

class SlowFakeGeminiProvider extends FakeGeminiProvider {
  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return super.generateText(request);
  }
}

class TimeoutFakeGeminiProvider extends FakeGeminiProvider {
  async generateText(): Promise<LlmTextResponse> {
    throw new ProviderRequestError("The OpenAI request timed out after 30s.");
  }

  async generateTextStream(): Promise<LlmTextResponse> {
    throw new ProviderRequestError("The OpenAI request timed out after 30s.");
  }
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
