import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellActionExecutor } from "../src/cli/shell-action-executor";
import { AppSettingsRepository } from "../src/storage/repositories/app-settings-repository";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("ShellActionExecutor resolves the saved companion pack by default", () => {
  const dbPath = tempDbPath("shell-executor-pack");
  const db = openDatabase(dbPath);

  try {
    const settings = new AppSettingsRepository(db);
    settings.setCompanionPackId("girlfriend", "2026-03-14T00:00:00.000Z");

    const executor = new ShellActionExecutor(db);
    const pack = executor.getActiveCompanionPack();

    assert.equal(pack.id, "girlfriend");
    assert.equal(pack.displayName, "Mina");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellActionExecutor can override the saved companion pack when building reactions", () => {
  const dbPath = tempDbPath("shell-executor-reaction");
  const db = openDatabase(dbPath);

  try {
    const settings = new AppSettingsRepository(db);
    settings.setCompanionPackId("momo", "2026-03-14T00:00:00.000Z");

    const executor = new ShellActionExecutor(db);
    const savedReaction = executor.buildCompanionReaction(
      {
        type: "review_session_complete",
        reviewedCount: 2
      },
      {
        status: {
          dueCount: 0,
          recentWord: "luminous"
        }
      }
    );
    const overriddenReaction = executor.buildCompanionReaction(
      {
        type: "review_session_complete",
        reviewedCount: 2
      },
      {
        packId: "girlfriend",
        status: {
          dueCount: 0,
          recentWord: "luminous"
        }
      }
    );

    assert.match(savedReaction.lineOverride ?? "", /Nice trot/i);
    assert.match(overriddenReaction.lineOverride ?? "", /together/i);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellActionExecutor exposes redacted settings plus usable API-key presence", () => {
  const dbPath = tempDbPath("shell-executor-settings");
  const db = openDatabase(dbPath);

  try {
    const settings = new AppSettingsRepository(db);
    settings.setStoredApiKey("gemini", "secret-key", "2026-03-14T00:00:00.000Z");

    const executor = new ShellActionExecutor(db);
    const listed = executor.listSettings();

    assert.equal(executor.hasAnyUsableProviderApiKey(), true);
    assert.ok(
      listed.some(
        (setting) => setting.key === "llm.api_key.gemini" && setting.value === "<redacted>"
      )
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("ShellActionExecutor can list and update the active companion pack", () => {
  const dbPath = tempDbPath("shell-executor-companion-config");
  const db = openDatabase(dbPath);

  try {
    const executor = new ShellActionExecutor(db);

    assert.ok(executor.listCompanionPacks().some((pack) => pack.id === "momo"));
    assert.equal(executor.getActiveCompanionPackId(), "momo");

    const selected = executor.setActiveCompanionPack("tsundere");

    assert.equal(selected.id, "tsundere");
    assert.equal(executor.getActiveCompanionPackId(), "tsundere");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
