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

test("ShellRunner reuses capture flow and updates companion output", async () => {
  const dbPath = tempDbPath("shell-runner");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      '/capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"',
      "/pet",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('I saved "luminous" as "emitting light"')),
      "expected shell-native capture reply inside shell"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I tucked "luminous" into the stack.')),
      "expected companion line to mention the captured word"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("(•ᴗ•)")),
      "expected shell to use compact companion presence lines"
    );

    const counts = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM lexemes) AS lexeme_count,
            (SELECT COUNT(*) FROM study_card) AS card_count
        `
      )
      .get() as Record<string, number>;

    assert.equal(counts.lexeme_count, 1);
    assert.equal(counts.card_count, 2);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner can use an LLM-generated companion voice bank for idle turns", async () => {
  const dbPath = tempDbPath("shell-runner-voice-bank");
  const db = openDatabase(dbPath);

  try {
    new AppSettingsRepository(db).setLlmSettings(
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: "test-key"
      },
      nowIso()
    );

    const terminal = new FakeShellTerminal(["", "", "/quit"]);
    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => new FakeGeminiProvider()
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) =>
        line.includes("Give me one honest word, and I'll keep it with me.")
      ),
      "expected the shell to replace idle companion copy with a generated voice-bank line"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner can emit debug lines when started with debug enabled", async () => {
  const dbPath = tempDbPath("shell-debug");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal(["/help", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      debug: true
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Debug: shell start")),
      "expected shell debug startup line"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Debug: agent response")),
      "expected shell debug agent response line"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("action: command")),
      "expected shell debug output to show the chosen action"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: execute action")),
      "expected shell debug output to include action timing"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: turn")),
      "expected shell debug output to include turn timing"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner can configure stream highlight from a shell command", async () => {
  const dbPath = tempDbPath("shell-highlight");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal(["/highlight 40 100", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) =>
        line.includes("Stream highlight now uses 40% of 100 characters")
      ),
      "expected the shell to confirm the explicit stream highlight window"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner debug mode prints perf timings for planner-backed study work", async () => {
  const dbPath = tempDbPath("shell-debug-perf");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal(["what does luminous mean?", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider,
      debug: true
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: planner")),
      "expected planner timing in debug mode"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: ask executor")),
      "expected ask timing in debug mode"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: ask render")),
      "expected render timing in debug mode"
    );
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

test("ShellRunner debug mode prints teach-stage perf breakdown", async () => {
  const dbPath = tempDbPath("shell-debug-teach-perf");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal(["加入 luminous", "yes", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider,
      debug: true
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: teach explanation llm")),
      "expected explanation timing in teach debug mode"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: teach card author llm")),
      "expected card-author timing in teach debug mode"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Perf: teach sqlite capture")),
      "expected sqlite capture timing in teach debug mode"
    );
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

test("ShellRunner can render with a romance-coded companion pack", async () => {
  const dbPath = tempDbPath("shell-runner-pack");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal(["/pet", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      packId: "tsundere"
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Airi · Chat")),
      "expected shell header to include active pack display name"
    );
    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes("stay a little") ||
          line.includes("longer if you want")
      ),
      "expected romance-coded pack line to appear"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("(•ᴗ•)")),
      "expected compact pack header inside the shell transcript"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner uses pack-specific review session completion reactions", async () => {
  const dbPath = tempDbPath("shell-review-reaction");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      '/capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"',
      "/review session",
      "",
      "good",
      "",
      "good",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      packId: "girlfriend"
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("We finished 2 cards together.")),
      "expected review completion reaction from companion pack"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner gives a warm intro before review when cards are due", async () => {
  const dbPath = tempDbPath("shell-review-intro");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      '/capture brisk --ctx "把 brisk 记下来" --gloss "轻快的"',
      "/review session --limit 1",
      "q",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("You have 2 cards due right now")),
      "expected a shell-native review intro before the raw session loop"
    );
    assert.ok(
      terminal.writes.some((line) => /FIRST UP|First up: brisk/.test(line)),
      "expected the shell review runner to use the warmer card heading copy"
    );
    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes("Ready to peek?") ||
          line.includes("Press Enter when you're ready to peek")
      ),
      "expected the shell review runner to use the warmer reveal prompt"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Type:")),
      "expected shell review to hide raw card metadata"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner uses a natural reply when review is requested with no due cards", async () => {
  const dbPath = tempDbPath("shell-review-empty");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal(["/review session", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("There aren't any due cards waiting")),
      "expected a shell-native empty review reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("PawMemo review session")),
      "expected the raw session runner to stay closed when there is no due work"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner greets a return-rescue session from bounded study state on startup", async () => {
  const dbPath = tempDbPath("shell-startup-return-rescue");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);
    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2000-01-01T09:00:00.000Z"
    });
    review.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2000-01-01T09:00:00.000Z"
    });

    const terminal = new FakeShellTerminal(["/quit"]);
    const runner = new ShellRunner({ db, terminal });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => /Welcome back after/i.test(line)),
      "expected a startup re-entry greeting"
    );
    assert.ok(
      terminal.writes.some((line) => /rescue "luminous" first/i.test(line)),
      "expected startup copy to point at the rescue target"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner surfaces the recent word on startup when the queue is clear", async () => {
  const dbPath = tempDbPath("shell-startup-resume-recent");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);
    capture.capture({
      word: "lucid",
      context: "Her explanation was lucid and easy to follow.",
      gloss: "clear and easy to understand",
      capturedAt: "2100-03-01T09:00:00.000Z"
    });

    review.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2100-03-01T09:00:00.000Z"
    });
    review.grade({
      cardId: 2,
      grade: "good",
      reviewedAt: "2100-03-01T09:01:00.000Z"
    });

    const terminal = new FakeShellTerminal(["/quit"]);
    const runner = new ShellRunner({ db, terminal });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => /"lucid" is still close to hand/i.test(line)),
      "expected startup copy to mention the recent word when nothing is due"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner surfaces return-after-gap summary from real review history", async () => {
  const dbPath = tempDbPath("shell-return-after-gap");
  const db = openDatabase(dbPath);

  try {
    const capture = new CaptureWordService(db);
    const review = new ReviewService(db);

    capture.capture({
      word: "luminous",
      context: "The jellyfish gave off a luminous glow.",
      gloss: "emitting light",
      capturedAt: "2026-03-01T09:00:00.000Z"
    });
    review.grade({
      cardId: 1,
      grade: "good",
      reviewedAt: "2026-03-01T09:00:00.000Z"
    });

    const terminal = new FakeShellTerminal([
      "/review session --limit 1",
      "",
      "good",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      packId: "girlfriend"
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => /You came back after \d+ days? and finished 1 card/.test(line)),
      "expected a shell-native return-after-gap summary inside shell"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Session summary")),
      "expected shell review to avoid the raw session-summary block"
    );
    assert.ok(
      terminal.writes.some((line) => /You came back after \d+ days?/.test(line)),
      "expected return-after-gap companion reaction from active pack"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner can show stats and queue a pack-specific stats reaction", async () => {
  const dbPath = tempDbPath("shell-stats");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      '/capture lucid --ctx "Her explanation was lucid and easy to follow." --gloss "clear and easy to understand"',
      "/stats",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      packId: "momo"
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Due now:") && line.includes("2")),
      "expected stats panel with due count inside shell"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Recovery")),
      "expected shell stats to avoid the raw recovery block"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("0 cards") && line.includes("steady in the pile")),
      "expected stats reaction from active companion pack"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner accepts natural-language capture input", async () => {
  const dbPath = tempDbPath("shell-natural-capture");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal([
      "记住 luminous = 发光的",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('I saved "luminous" as "发光的"')),
      "expected natural capture input to use the shell-native capture reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Gloss: 发光的")),
      "expected shell capture output to avoid the raw capture block"
    );
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

test("ShellRunner accepts natural-language ask input", { concurrency: false }, async () => {
  const dbPath = tempDbPath("shell-natural-ask");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal([
      "what does luminous mean?",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('Here "luminous" mainly means "emitting light"')),
      "expected natural ask input to use the shell-native ask reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Word: luminous")),
      "expected shell ask output to avoid the raw ask block"
    );
    assert.ok(
      terminal.writes.some((line) => /EXPLAIN CARD|Explain card/.test(line)),
      "expected shell ask output to add a structured explanation card"
    );
    assert.ok(
      terminal.writes.some((line) => /SPOTLIGHT|Spotlight/.test(line)),
      "expected shell ask card to include provider-returned spotlight phrases"
    );
    assert.match(fakeProvider.lastRequest?.userPrompt ?? "", /luminous/i);
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

test("ShellRunner asks for confirmation before teach-style save actions", async () => {
  const dbPath = tempDbPath("shell-natural-teach");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal([
      "加入 luminous",
      "yes",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes('drafted a card for "luminous"') ||
          line.includes("起草成一张卡")
      ),
      "expected the shell to ask for confirmation before saving"
    );
    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes("Recognition") ||
          line.includes("识义卡")
      ),
      "expected the shell to preview the drafted study card before saving"
    );
    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes("Save 2 cards") ||
          line.includes("加入这 2 张卡")
      ),
      "expected the shell to show explicit save choices before persisting"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I taught "luminous" as "emitting light"')),
      "expected confirmation to continue into the shell-native teach reply"
    );
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

test("ShellRunner asks how to continue when teach intent lacks a usable example sentence", { concurrency: false }, async () => {
  const dbPath = tempDbPath("shell-natural-teach-clarify");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal([
      "i want to learning spire",
      "definition",
      "yes",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("not a usable example sentence")),
      "expected the shell to explain why it is asking for clarification"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Definition card")),
      "expected the shell to show the structured clarification choices"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("____ means 尖塔.")),
      "expected the shell to preview the definition-style cloze card after explicit selection"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes('What does "spire" mean in this context?')),
      "expected definition-mode save to avoid creating a recognition card that reveals the answer"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes('I taught "spire" as "尖塔"')),
      "expected the shell to complete the teach flow after the explicit definition-card choice"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("clear review card")),
      "expected the old card-author failure message to stay hidden"
    );
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
