import type { WordMasteryRecord } from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapMastery(row: Record<string, unknown>): WordMasteryRecord {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    state: row.state as WordMasteryRecord["state"],
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    lastReviewedAt: nullableString(row.last_reviewed_at),
    nextDueAt: nullableString(row.next_due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class MasteryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  ensureSeen(lexemeId: number, timestamp: string): WordMasteryRecord {
    this.db.prepare(
      `
        INSERT INTO word_mastery (
          lexeme_id,
          state,
          stability,
          difficulty,
          last_reviewed_at,
          next_due_at,
          created_at,
          updated_at
        )
        VALUES (@lexemeId, 'seen', 0, 0, NULL, @nextDueAt, @createdAt, @updatedAt)
        ON CONFLICT(lexeme_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `
    ).run({
      lexemeId,
      nextDueAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            lexeme_id,
            state,
            stability,
            difficulty,
            last_reviewed_at,
            next_due_at,
            created_at,
            updated_at
          FROM word_mastery
          WHERE lexeme_id = ?
        `
      )
      .get(lexemeId) as Record<string, unknown>;

    return mapMastery(row);
  }

  getByLexemeId(lexemeId: number): WordMasteryRecord {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            lexeme_id,
            state,
            stability,
            difficulty,
            last_reviewed_at,
            next_due_at,
            created_at,
            updated_at
          FROM word_mastery
          WHERE lexeme_id = ?
        `
      )
      .get(lexemeId) as Record<string, unknown>;

    return mapMastery(row);
  }

  applyReview(
    lexemeId: number,
    update: {
      state: WordMasteryRecord["state"];
      stability: number;
      difficulty: number;
      lastReviewedAt: string;
      nextDueAt: string;
      updatedAt: string;
    }
  ): WordMasteryRecord {
    this.db.prepare(
      `
        UPDATE word_mastery
        SET
          state = @state,
          stability = @stability,
          difficulty = @difficulty,
          last_reviewed_at = @lastReviewedAt,
          next_due_at = @nextDueAt,
          updated_at = @updatedAt
        WHERE lexeme_id = @lexemeId
      `
    ).run({
      lexemeId,
      state: update.state,
      stability: update.stability,
      difficulty: update.difficulty,
      lastReviewedAt: update.lastReviewedAt,
      nextDueAt: update.nextDueAt,
      updatedAt: update.updatedAt
    });

    return this.getByLexemeId(lexemeId);
  }
}
