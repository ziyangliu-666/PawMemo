import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AppSettingsRepository } from "../src/storage/repositories/app-settings-repository";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("AppSettingsRepository redacts stored API keys from list output", () => {
  const dbPath = tempDbPath("app-settings");
  const db = openDatabase(dbPath);

  try {
    const settings = new AppSettingsRepository(db);
    settings.setStoredApiKey(
      "gemini",
      "stored-secret-key",
      "2026-03-12T00:00:00.000Z"
    );

    assert.equal(settings.getStoredApiKey("gemini"), "stored-secret-key");
    assert.equal(settings.hasAnyStoredApiKey(), true);

    const listed = settings.list();
    const keyRow = listed.find((setting) => setting.key === "llm.api_key.gemini");

    assert.ok(keyRow);
    assert.equal(keyRow?.value, "<redacted>");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("AppSettingsRepository remembers models per provider while tracking the active provider", () => {
  const dbPath = tempDbPath("app-settings-models");
  const db = openDatabase(dbPath);

  try {
    const settings = new AppSettingsRepository(db);
    settings.setLlmSettings(
      {
        provider: "openai",
        model: "gpt-5-mini",
        apiKey: null,
        apiUrl: "http://172.24.160.1:7861/v1/"
      },
      "2026-03-12T00:00:00.000Z"
    );

    assert.equal(settings.getLlmSettings().provider, "openai");
    assert.equal(settings.getLlmSettings().model, "gpt-5-mini");
    assert.equal(settings.getLlmSettings().apiUrl, "http://172.24.160.1:7861/v1");
    assert.equal(settings.getStoredModel("openai"), "gpt-5-mini");

    settings.setLlmSettings(
      {
        provider: "gemini",
        model: "gemini-2.5-pro",
        apiKey: null
      },
      "2026-03-12T00:10:00.000Z"
    );

    assert.equal(settings.getStoredModel("openai"), "gpt-5-mini");
    assert.equal(settings.getStoredApiUrl("openai"), "http://172.24.160.1:7861/v1");
    assert.equal(settings.getStoredModel("gemini"), "gemini-2.5-pro");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
