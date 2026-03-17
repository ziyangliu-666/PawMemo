import type { MasteryState, StudyEntryRecord } from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function mapStudyEntry(row: Record<string, unknown>): StudyEntryRecord {
  return {
    id: Number(row.entry_id),
    lexemeId: Number(row.lexeme_id),
    state: row.state as MasteryState,
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    lastReviewedAt: nullableString(row.last_reviewed_at),
    nextDueAt: nullableString(row.next_due_at),
    createdAt: String(row.entry_created_at),
    updatedAt: String(row.ems_updated_at)
  };
}

const SELECT_JOIN = `
  SELECT
    se.id AS entry_id,
    se.lexeme_id,
    se.created_at AS entry_created_at,
    ems.state,
    ems.stability,
    ems.difficulty,
    ems.last_reviewed_at,
    ems.next_due_at,
    ems.updated_at AS ems_updated_at
  FROM study_entry se
  JOIN entry_memory_state ems ON ems.study_entry_id = se.id
`;

export class StudyEntryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  ensureSeen(lexemeId: number, timestamp: string): StudyEntryRecord {
    this.db.prepare(
      `
        INSERT INTO study_entry (lexeme_id, created_at, updated_at)
        VALUES (@lexemeId, @timestamp, @timestamp)
        ON CONFLICT(lexeme_id) DO UPDATE SET updated_at = excluded.updated_at
      `
    ).run({ lexemeId, timestamp });

    const entryRow = this.db
      .prepare(`SELECT id FROM study_entry WHERE lexeme_id = ?`)
      .get(lexemeId) as { id: number };

    this.db.prepare(
      `
        INSERT INTO entry_memory_state (
          study_entry_id,
          state,
          stability,
          difficulty,
          last_reviewed_at,
          next_due_at,
          created_at,
          updated_at
        )
        VALUES (@entryId, 'seen', 0, 0, NULL, @nextDueAt, @timestamp, @timestamp)
        ON CONFLICT(study_entry_id) DO UPDATE SET updated_at = excluded.updated_at
      `
    ).run({ entryId: entryRow.id, nextDueAt: timestamp, timestamp });

    return this.getByLexemeId(lexemeId);
  }

  getByLexemeId(lexemeId: number): StudyEntryRecord {
    const row = this.db
      .prepare(`${SELECT_JOIN} WHERE se.lexeme_id = ?`)
      .get(lexemeId) as Record<string, unknown>;

    return mapStudyEntry(row);
  }

  applyReview(
    lexemeId: number,
    update: {
      state: MasteryState;
      stability: number;
      difficulty: number;
      lastReviewedAt: string;
      nextDueAt: string;
      updatedAt: string;
    }
  ): StudyEntryRecord {
    this.db.prepare(
      `
        UPDATE entry_memory_state
        SET
          state = @state,
          stability = @stability,
          difficulty = @difficulty,
          last_reviewed_at = @lastReviewedAt,
          next_due_at = @nextDueAt,
          updated_at = @updatedAt
        WHERE study_entry_id = (
          SELECT id FROM study_entry WHERE lexeme_id = @lexemeId
        )
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

    this.db.prepare(
      `UPDATE study_entry SET updated_at = ? WHERE lexeme_id = ?`
    ).run(update.updatedAt, lexemeId);

    return this.getByLexemeId(lexemeId);
  }
}
