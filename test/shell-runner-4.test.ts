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

test("ShellRunner supports interactive /models switching", async () => {
  const dbPath = tempDbPath("shell-model-picker");
  const db = openDatabase(dbPath);
  const priorOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  try {
    const terminal = new FakeShellTerminal([
      "/models",
      "openai",
      "gpt-5-mini",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: (name) => ({
        name,
        async generateText() {
          throw new Error("generateText should not be called during /models");
        },
        async listModels() {
          if (name === "openai") {
            return [
              {
                id: "gpt-5-mini",
                provider: "openai",
                displayName: "GPT-5 Mini",
                createdAt: null,
                ownedBy: "openai"
              },
              {
                id: "gpt-5",
                provider: "openai",
                displayName: "GPT-5",
                createdAt: null,
                ownedBy: "openai"
              }
            ];
          }

          return [
            {
              id: "gemini-2.5-flash",
              provider: "gemini",
              displayName: "Gemini 2.5 Flash",
              createdAt: null,
              ownedBy: "google"
            }
          ];
        }
      })
    });

    await runner.run();

    const settings = db
      .prepare(
        `
          SELECT key, value
          FROM app_settings
          WHERE key IN ('llm.provider', 'llm.model', 'llm.model.openai')
          ORDER BY key ASC
        `
      )
      .all() as Array<{ key: string; value: string }>;

    assert.deepEqual(settings, [
      { key: "llm.model", value: "gpt-5-mini" },
      { key: "llm.model.openai", value: "gpt-5-mini" },
      { key: "llm.provider", value: "openai" }
    ]);
    assert.ok(
      terminal.writes.some((line) => line.includes("Pick a provider")),
      "expected /models to ask for a provider first"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Pick a openai model")),
      "expected /models to ask for a model next"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('Switched to openai with "gpt-5-mini".')),
      "expected /models to confirm the quick switch in a short shell reply"
    );
  } finally {
    if (priorOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = priorOpenAiApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner keeps large /models catalogs on a quick-switch shortlist first", async () => {
  const dbPath = tempDbPath("shell-model-picker-shortlist");
  const db = openDatabase(dbPath);
  const priorOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-openai-key";

  try {
    const manyModels: LlmModelInfo[] = Array.from({ length: 16 }, (_, index) => ({
      id: `gpt-5-variant-${String(index + 1).padStart(2, "0")}`,
      provider: "openai" as const,
      displayName: null,
      createdAt: null,
      ownedBy: "openai"
    }));

    manyModels.unshift(
      {
        id: "gpt-5-mini",
        provider: "openai",
        displayName: "GPT-5 Mini",
        createdAt: null,
        ownedBy: "openai"
      },
      {
        id: "gpt-5",
        provider: "openai",
        displayName: "GPT-5",
        createdAt: null,
        ownedBy: "openai"
      }
    );

    const terminal = new FakeShellTerminal([
      "/models openai",
      "b",
      "gpt-5",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: (name) => ({
        name,
        async generateText() {
          throw new Error("generateText should not be called during /models");
        },
        async listModels() {
          if (name === "openai") {
            return manyModels;
          }

          return [
            {
              id: "gemini-2.5-flash",
              provider: "gemini",
              displayName: "Gemini 2.5 Flash",
              createdAt: null,
              ownedBy: "google"
            }
          ];
        }
      })
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Quick switch openai")),
      "expected /models to open with a quick-switch shortlist for large catalogs"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Browse all models")),
      "expected the shortlist to offer an explicit browse-all step"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Browse all openai models")),
      "expected the full list to appear only after the explicit browse step"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('Switched to openai with "gpt-5".')),
      "expected the large-catalog quick switch to end with a short confirmation"
    );
  } finally {
    if (priorOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = priorOpenAiApiKey;
    }

    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
