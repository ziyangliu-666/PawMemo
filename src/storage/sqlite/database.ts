import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { nowIso } from "../../lib/time";
import { runMigrations } from "./migrations";

export type SqliteDatabase = InstanceType<typeof Database>;

export function resolveDatabasePath(dbPath?: string): string {
  if (dbPath && dbPath.trim().length > 0) {
    return dbPath;
  }

  if (process.env.PAWMEMO_DB_PATH && process.env.PAWMEMO_DB_PATH.trim().length > 0) {
    return process.env.PAWMEMO_DB_PATH;
  }

  return path.resolve(process.cwd(), ".data", "pawmemo.db");
}

function seedDefaults(db: SqliteDatabase): void {
  const currentTime = nowIso();

  db.prepare(
    `
      INSERT INTO users (id, display_name, created_at, updated_at)
      VALUES (1, @displayName, @createdAt, @updatedAt)
      ON CONFLICT(id) DO NOTHING
    `
  ).run({
    displayName: "friend",
    createdAt: currentTime,
    updatedAt: currentTime
  });

  db.prepare(
    `
      INSERT INTO user_preferences (
        id,
        user_id,
        daily_new_limit,
        daily_review_limit,
        companion_style,
        created_at,
        updated_at
      )
      VALUES (1, 1, 10, 40, 'warm', @createdAt, @updatedAt)
      ON CONFLICT(id) DO NOTHING
    `
  ).run({
    createdAt: currentTime,
    updatedAt: currentTime
  });

  db.prepare(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO NOTHING
    `
  ).run({
    key: "llm.provider",
    value: "gemini",
    updatedAt: currentTime
  });

  db.prepare(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO NOTHING
    `
  ).run({
    key: "llm.model",
    value: "gemini-2.5-flash",
    updatedAt: currentTime
  });

  db.prepare(
    `
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (@key, @value, @updatedAt)
      ON CONFLICT(key) DO NOTHING
    `
  ).run({
    key: "companion.pack_id",
    value: "momo",
    updatedAt: currentTime
  });
}

export function openDatabase(dbPath?: string): SqliteDatabase {
  const resolvedPath = resolveDatabasePath(dbPath);

  if (resolvedPath !== ":memory:") {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  runMigrations(db);
  seedDefaults(db);

  return db;
}
