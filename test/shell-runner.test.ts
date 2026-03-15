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
            (SELECT COUNT(*) FROM review_cards) AS card_count
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
      terminal.writes.some((line) => line.includes("You have 2 cards due right now")),
      "expected shell-native stats summary inside shell"
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

test("ShellRunner renders a waiting capsule while planner work is in flight", async () => {
  const dbPath = tempDbPath("shell-waiting");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new SlowFakeGeminiProvider();
    const terminal = new FakeShellTerminal(["what does luminous mean?", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some(
        (line) =>
          /Give me a beat\.|Nosing through the word pile/i.test(line)
      ),
      "expected a waiting capsule before the reply"
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

test("ShellRunner translates unknown slash commands into a conversational error", async () => {
  const dbPath = tempDbPath("shell-unknown-command");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal(["/roles", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("I don't know `/roles` yet.")),
      "expected a friendly unknown-command reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Unknown shell command: roles")),
      "expected the raw usage error to stay hidden from the shell surface"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner stops waiting and surfaces a timeout when planner work stalls", async () => {
  const dbPath = tempDbPath("shell-timeout");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const terminal = new FakeShellTerminal(["加入新卡片 spire", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => new TimeoutFakeGeminiProvider()
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("stopped waiting")),
      "expected a timeout-specific shell reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Unknown error")),
      "expected shell timeout handling to stay conversational"
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

test("ShellRunner can guide the learner into rescue from a slash command", async () => {
  const dbPath = tempDbPath("shell-rescue-command");
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
      "/rescue",
      "",
      "good",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('We\'ll rescue "luminous" first')),
      "expected a shell-native rescue intro"
    );
    assert.ok(
      terminal.writes.some((line) => /FIRST UP|First up: luminous/.test(line)),
      "expected rescue to reuse the deterministic review runner with shell copy"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellRunner accepts natural-language rescue input", async () => {
  const dbPath = tempDbPath("shell-natural-rescue");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

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

    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal([
      "救一下",
      "q",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes('We\'ll rescue "luminous" first')),
      "expected natural-language rescue input to enter rescue"
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

test("ShellRunner streams planner replies when the terminal supports raw writes", async () => {
  const dbPath = tempDbPath("shell-streaming-reply");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeStreamingShellTerminal(["这是啥", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.equal(fakeProvider.streamCalls, 1);
    assert.ok(
      terminal.rawWrites.length > 2,
      "expected the shell to emit planner reply chunks through raw writes"
    );
    assert.equal(
      terminal.rawWrites.join(""),
      "我是 PawMemo 的学习 shell。\n",
      "expected the planner reply to be written progressively"
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

test("ShellRunner uses planner replies for unmatched natural chat", async () => {
  const dbPath = tempDbPath("shell-planner-chat");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal(["这是啥", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("我是 PawMemo 的学习 shell。")),
      "expected the shell to render a planner reply for unmatched chat"
    );
    assert.match(fakeProvider.lastRequest?.systemInstruction ?? "", /shell planner/i);
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
          SELECT id, answer_text, lifecycle_state
          FROM review_cards
          ORDER BY id ASC
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

test("ShellRunner can show model status and list models from slash commands", async () => {
  const dbPath = tempDbPath("shell-model-list");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";

  try {
    const fakeProvider = new FakeGeminiProvider();
    const terminal = new FakeShellTerminal(["/model", "/model list", "/quit"]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: () => fakeProvider
    });

    await runner.run();

    assert.ok(
      terminal.writes.some((line) => line.includes("Current: gemini (gemini-2.5-flash)")),
      "expected /model to show the active provider and model"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Models (gemini)")),
      "expected /model list to print provider models"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("gemini-2.5-pro")),
      "expected /model list to include provider model ids"
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

test("ShellRunner supports explicit /model use, key, and url commands", async () => {
  const dbPath = tempDbPath("shell-model-switch");
  const db = openDatabase(dbPath);

  try {
    const terminal = new FakeShellTerminal([
      "/model use openai gpt-5-mini",
      "/model key openai test-openai-key",
      "/model url openai http://172.24.160.1:7861/v1/",
      "/model use gemini",
      "/quit"
    ]);

    const runner = new ShellRunner({
      db,
      terminal,
      providerFactory: (name) => {
        if (name !== "gemini") {
          throw new Error("provider should not be called during /model status updates");
        }

        return new FakeGeminiProvider();
      }
    });

    await runner.run();

    const settings = db
      .prepare(
        `
          SELECT key, value
          FROM app_settings
          WHERE key IN ('llm.provider', 'llm.model', 'llm.model.openai', 'llm.api_key.openai', 'llm.api_url.openai')
          ORDER BY key ASC
        `
      )
      .all() as Array<{ key: string; value: string }>;

    assert.deepEqual(settings, [
      { key: "llm.api_key.openai", value: "test-openai-key" },
      { key: "llm.api_url.openai", value: "http://172.24.160.1:7861/v1" },
      { key: "llm.model", value: "gemini-2.5-flash" },
      { key: "llm.model.openai", value: "gpt-5-mini" },
      { key: "llm.provider", value: "gemini" }
    ]);
    assert.ok(
      terminal.writes.some(
        (line) =>
          line.includes("openai") &&
          line.includes("api key yes") &&
          line.includes("http://172.24.160.1:7861/v1")
      ),
      "expected /model key and /model url to confirm the stored OpenAI key and URL"
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

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
