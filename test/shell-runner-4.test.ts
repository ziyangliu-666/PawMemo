import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellRunner } from "../src/cli/shell-runner";
import type { LlmModelInfo } from "../src/core/domain/models";
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
