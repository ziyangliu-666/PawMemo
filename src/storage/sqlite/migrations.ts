import type Database from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof Database>;

const MIGRATIONS: string[] = [
  `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      daily_new_limit INTEGER NOT NULL,
      daily_review_limit INTEGER NOT NULL,
      companion_style TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS relationship_memories (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      salience REAL NOT NULL DEFAULT 0,
      source_event_id INTEGER,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS lexemes (
      id INTEGER PRIMARY KEY,
      lemma TEXT NOT NULL,
      normalized TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lexemes_normalized
    ON lexemes(normalized)
  `,
  `
    CREATE TABLE IF NOT EXISTS word_senses (
      id INTEGER PRIMARY KEY,
      lexeme_id INTEGER NOT NULL,
      sense_key TEXT NOT NULL,
      gloss TEXT NOT NULL,
      example_context TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (lexeme_id, sense_key),
      FOREIGN KEY (lexeme_id) REFERENCES lexemes(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS word_encounters (
      id INTEGER PRIMARY KEY,
      lexeme_id INTEGER NOT NULL,
      context_text TEXT NOT NULL,
      source_label TEXT,
      captured_at TEXT NOT NULL,
      UNIQUE (lexeme_id, context_text),
      FOREIGN KEY (lexeme_id) REFERENCES lexemes(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_word_encounters_lexeme
    ON word_encounters(lexeme_id)
  `,
  `
    CREATE TABLE IF NOT EXISTS word_mastery (
      id INTEGER PRIMARY KEY,
      lexeme_id INTEGER NOT NULL,
      state TEXT NOT NULL,
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 0,
      last_reviewed_at TEXT,
      next_due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (lexeme_id),
      FOREIGN KEY (lexeme_id) REFERENCES lexemes(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS review_cards (
      id INTEGER PRIMARY KEY,
      lexeme_id INTEGER NOT NULL,
      card_type TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      answer_text TEXT NOT NULL,
      state TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (lexeme_id) REFERENCES lexemes(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_review_cards_due
    ON review_cards(state, due_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS review_history (
      id INTEGER PRIMARY KEY,
      review_card_id INTEGER NOT NULL,
      grade TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      scheduled_days REAL NOT NULL DEFAULT 0,
      stability_after REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (review_card_id) REFERENCES review_cards(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_event_log_type_created
    ON event_log(event_type, created_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY,
      session_key TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS active_word_set (
      id INTEGER PRIMARY KEY,
      lexeme_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (lexeme_id) REFERENCES lexemes(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_active_word_set_expiry
    ON active_word_set(expires_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
];

export function runMigrations(db: SqliteDatabase): void {
  for (const statement of MIGRATIONS) {
    db.exec(statement);
  }
}
