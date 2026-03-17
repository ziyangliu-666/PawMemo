import Database from "better-sqlite3";

import type { WordEncounterRecord } from "../../core/domain/models";
import { DuplicateEncounterError } from "../../lib/errors";
import type { SqliteDatabase } from "../sqlite/database";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapEncounter(row: Record<string, unknown>): WordEncounterRecord {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    contextText: String(row.context_text),
    sourceLabel: nullableString(row.source_label),
    capturedAt: String(row.captured_at)
  };
}

export class EncounterRepository {
  constructor(private readonly db: SqliteDatabase) {}

  countByLexemeId(lexemeId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM word_encounters WHERE lexeme_id = ?`
      )
      .get(lexemeId) as { count: number };

    return row.count;
  }

  create(
    lexemeId: number,
    contextText: string,
    sourceLabel: string | undefined,
    capturedAt: string
  ): WordEncounterRecord {
    try {
      const result = this.db
        .prepare(
          `
            INSERT INTO word_encounters (lexeme_id, context_text, source_label, captured_at)
            VALUES (@lexemeId, @contextText, @sourceLabel, @capturedAt)
          `
        )
        .run({
          lexemeId,
          contextText,
          sourceLabel: sourceLabel ?? null,
          capturedAt
        });

      const row = this.db
        .prepare(
          `
            SELECT id, lexeme_id, context_text, source_label, captured_at
            FROM word_encounters
            WHERE id = ?
          `
        )
        .get(result.lastInsertRowid) as Record<string, unknown>;

      return mapEncounter(row);
    } catch (error) {
      if (
        error instanceof Database.SqliteError &&
        error.code === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new DuplicateEncounterError(
          "That word has already been captured with the same context."
        );
      }

      throw error;
    }
  }
}
