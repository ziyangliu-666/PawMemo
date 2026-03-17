import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { openDatabase } from "../src/storage/sqlite/database";
import { LATEST_SCHEMA_VERSION } from "../src/storage/sqlite/migrations";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("openDatabase stores and reuses the latest schema version", () => {
  const dbPath = tempDbPath("migrations-versioned");
  const first = openDatabase(dbPath);

  try {
    const row = first
      .prepare<[], { version: number }>(
        `
          SELECT version
          FROM schema_version
          WHERE id = 1
        `
      )
      .get();

    assert.equal(row?.version, LATEST_SCHEMA_VERSION);

    const deadTables = first
      .prepare<[string, string], { name: string }>(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = ? AND name = ?
        `
      );

    assert.equal(deadTables.get("table", "relationship_memories"), undefined);
    assert.equal(deadTables.get("table", "session_summaries"), undefined);
  } finally {
    first.close();
  }

  const second = openDatabase(dbPath);

  try {
    const row = second
      .prepare<[], { version: number }>(
        `
          SELECT version
          FROM schema_version
          WHERE id = 1
        `
      )
      .get();

    assert.equal(row?.version, LATEST_SCHEMA_VERSION);
  } finally {
    second.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("runMigrations upgrades a legacy database and drops dead tables", () => {
  const dbPath = tempDbPath("migrations-legacy");
  const legacyDb = new Database(dbPath);

  try {
    legacyDb.exec(`
      CREATE TABLE relationship_memories (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0,
        source_event_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY,
        session_key TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL
      );
    `);
  } finally {
    legacyDb.close();
  }

  const migrated = openDatabase(dbPath);

  try {
    const tables = migrated
      .prepare<[], { name: string }>(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
        `
      )
      .all()
      .map((row) => row.name);

    assert.ok(tables.includes("schema_version"));
    assert.ok(tables.includes("users"));
    assert.ok(!tables.includes("relationship_memories"));
    assert.ok(!tables.includes("session_summaries"));

    const version = migrated
      .prepare<[], { version: number }>(
        `
          SELECT version
          FROM schema_version
          WHERE id = 1
        `
      )
      .get();

    assert.equal(version?.version, LATEST_SCHEMA_VERSION);
  } finally {
    migrated.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test("V4 migration: new tables exist, old tables are gone, review_history uses study_card_id", () => {
  const dbPath = tempDbPath("migrations-v4");
  const db = openDatabase(dbPath);

  try {
    const tableNames = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`
      )
      .all()
      .map((row) => row.name);

    assert.ok(tableNames.includes("study_card"), "study_card table should exist");
    assert.ok(tableNames.includes("card_learning_state"), "card_learning_state table should exist");
    assert.ok(tableNames.includes("study_entry"), "study_entry table should exist");
    assert.ok(tableNames.includes("entry_memory_state"), "entry_memory_state table should exist");
    assert.ok(tableNames.includes("review_history"), "review_history table should exist");
    assert.ok(!tableNames.includes("review_cards"), "review_cards table should be gone");
    assert.ok(!tableNames.includes("word_mastery"), "word_mastery table should be gone");

    const historyColumns = db
      .prepare<[], { name: string }>(
        `SELECT name FROM pragma_table_info('review_history')`
      )
      .all()
      .map((row) => row.name);

    assert.ok(historyColumns.includes("study_card_id"), "review_history should have study_card_id column");
    assert.ok(!historyColumns.includes("review_card_id"), "review_history should not have old review_card_id column");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
