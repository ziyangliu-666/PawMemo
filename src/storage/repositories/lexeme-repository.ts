import type {
  LexemeRecord,
  WordSenseRecord
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function mapLexeme(row: Record<string, unknown>): LexemeRecord {
  return {
    id: Number(row.id),
    lemma: String(row.lemma),
    normalized: String(row.normalized),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapSense(row: Record<string, unknown>): WordSenseRecord {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    senseKey: String(row.sense_key),
    gloss: String(row.gloss),
    exampleContext: String(row.example_context),
    createdAt: String(row.created_at)
  };
}

export class LexemeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  findByNormalized(normalized: string): LexemeRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT id, lemma, normalized, created_at, updated_at
          FROM lexemes
          WHERE normalized = ?
        `
      )
      .get(normalized) as Record<string, unknown> | undefined;

    return row ? mapLexeme(row) : null;
  }

  upsert(lemma: string, normalized: string, timestamp: string): LexemeRecord {
    this.db.prepare(
      `
        INSERT INTO lexemes (lemma, normalized, created_at, updated_at)
        VALUES (@lemma, @normalized, @createdAt, @updatedAt)
        ON CONFLICT(normalized) DO UPDATE SET
          lemma = excluded.lemma,
          updated_at = excluded.updated_at
      `
    ).run({
      lemma,
      normalized,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const row = this.db
      .prepare(
        `
          SELECT id, lemma, normalized, created_at, updated_at
          FROM lexemes
          WHERE normalized = ?
        `
      )
      .get(normalized) as Record<string, unknown>;

    return mapLexeme(row);
  }

  upsertSense(
    lexemeId: number,
    gloss: string,
    exampleContext: string,
    timestamp: string
  ): WordSenseRecord {
    const senseKey = gloss.trim().toLowerCase();

    this.db.prepare(
      `
        INSERT INTO word_senses (lexeme_id, sense_key, gloss, example_context, created_at)
        VALUES (@lexemeId, @senseKey, @gloss, @exampleContext, @createdAt)
        ON CONFLICT(lexeme_id, sense_key) DO UPDATE SET
          gloss = excluded.gloss,
          example_context = excluded.example_context
      `
    ).run({
      lexemeId,
      senseKey,
      gloss,
      exampleContext,
      createdAt: timestamp
    });

    const row = this.db
      .prepare(
        `
          SELECT id, lexeme_id, sense_key, gloss, example_context, created_at
          FROM word_senses
          WHERE lexeme_id = ? AND sense_key = ?
        `
      )
      .get(lexemeId, senseKey) as Record<string, unknown>;

    return mapSense(row);
  }
}
