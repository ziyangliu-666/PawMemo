import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellRunner } from "../src/cli/shell-runner";
import { CaptureWordService } from "../src/core/orchestration/capture-word";
import { ReviewService } from "../src/core/orchestration/review-service";
import type { LlmProvider, LlmTextRequest, LlmTextResponse } from "../src/llm/types";
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

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    this.lastRequest = request;

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

      return {
        text: JSON.stringify({
          kind: "reply",
          message: "我是 PawMemo 的学习 shell。"
        })
      };
    }

    return {
      text: JSON.stringify({
        gloss: "emitting light",
        explanation: "Here it describes something that gives off light.",
        usage_note: "Often used for light or glowing surfaces.",
        confidence_note: "The phrasing is clear enough to explain directly."
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
}

class SlowFakeGeminiProvider extends FakeGeminiProvider {
  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    await new Promise((resolve) => setTimeout(resolve, 220));
    return super.generateText(request);
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
      terminal.writes.some((line) => line.includes("U•ᴥ•U")),
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
      terminal.writes.some((line) => line.includes("(¬_¬)")),
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
      terminal.writes.some((line) => line.includes("First up: brisk")),
      "expected the shell review runner to use the warmer card heading copy"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Press Enter when you're ready to peek")),
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

test("ShellRunner accepts natural-language ask input", async () => {
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
      terminal.writes.some((line) => line.includes('Here "luminous" means "emitting light"')),
      "expected natural ask input to use the shell-native ask reply"
    );
    assert.ok(
      terminal.writes.every((line) => !line.includes("Word: luminous")),
      "expected shell ask output to avoid the raw ask block"
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
          line.includes('I spotted "luminous" as a word to learn') ||
          line.includes("add it to your study plan")
      ),
      "expected the shell to ask for confirmation before saving"
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
      terminal.writes.some((line) => line.includes("First up: luminous")),
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

test("ShellRunner shows planner setup guidance when no API key is configured", async () => {
  const dbPath = tempDbPath("shell-planner-guidance");
  const db = openDatabase(dbPath);
  const priorApiKey = process.env.GEMINI_API_KEY;
  const priorGoogleApiKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;

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
      terminal.writes.some((line) => line.includes("I need a live model connection before I can handle natural chat.")),
      "expected setup guidance when planner configuration is missing"
    );
    assert.ok(
      terminal.writes.some((line) => line.includes("Check `/model`, or set a key there and try again.")),
      "expected model guidance when planner configuration is missing"
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
