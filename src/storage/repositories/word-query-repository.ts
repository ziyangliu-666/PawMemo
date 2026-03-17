import type {
  LexemeRecord,
  StudyEntryRecord,
  WordEncounterRecord,
  WordKnowledgeSnapshot,
  WordSenseRecord
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

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
    id: Number(row.sense_id),
    lexemeId: Number(row.lexeme_id),
    senseKey: String(row.sense_key),
    gloss: String(row.gloss),
    exampleContext: String(row.example_context),
    createdAt: String(row.sense_created_at)
  };
}

function mapStudyEntry(row: Record<string, unknown>): StudyEntryRecord {
  return {
    id: Number(row.entry_id),
    lexemeId: Number(row.lexeme_id),
    state: row.state as StudyEntryRecord["state"],
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    lastReviewedAt: nullableString(row.last_reviewed_at),
    nextDueAt: nullableString(row.next_due_at),
    createdAt: String(row.entry_created_at),
    updatedAt: String(row.entry_updated_at)
  };
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

export class WordQueryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getKnowledgeByNormalized(normalized: string): WordKnowledgeSnapshot | null {
    const row = this.db
      .prepare(
        `
          SELECT
            lexemes.id,
            lexemes.lemma,
            lexemes.normalized,
            lexemes.created_at,
            lexemes.updated_at,
            word_senses.id AS sense_id,
            word_senses.sense_key,
            word_senses.gloss,
            word_senses.example_context,
            word_senses.created_at AS sense_created_at,
            se.id AS entry_id,
            ems.state,
            ems.stability,
            ems.difficulty,
            ems.last_reviewed_at,
            ems.next_due_at,
            se.created_at AS entry_created_at,
            se.updated_at AS entry_updated_at
          FROM lexemes
          LEFT JOIN word_senses
            ON word_senses.id = (
              SELECT ws.id
              FROM word_senses AS ws
              WHERE ws.lexeme_id = lexemes.id
              ORDER BY ws.id DESC
              LIMIT 1
            )
          LEFT JOIN study_entry se
            ON se.lexeme_id = lexemes.id
          LEFT JOIN entry_memory_state ems
            ON ems.study_entry_id = se.id
          WHERE lexemes.normalized = ?
        `
      )
      .get(normalized) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const lexeme = mapLexeme(row);
    const recentEncounters = this.listRecentEncounters(lexeme.id, 2);

    return {
      lexeme,
      sense: row.sense_id === null ? null : mapSense(row),
      mastery: row.entry_id === null ? null : mapStudyEntry(row),
      recentEncounters
    };
  }

  listRecentWords(limit: number): string[] {
    const rows = this.db
      .prepare(
        `
          SELECT lexemes.lemma
          FROM lexemes
          INNER JOIN (
            SELECT lexeme_id, MAX(captured_at) AS latest_captured_at
            FROM word_encounters
            GROUP BY lexeme_id
            ORDER BY latest_captured_at DESC
            LIMIT ?
          ) AS recent_words
            ON recent_words.lexeme_id = lexemes.id
          ORDER BY recent_words.latest_captured_at DESC
        `
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => String(row.lemma));
  }

  private listRecentEncounters(
    lexemeId: number,
    limit: number
  ): WordEncounterRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, lexeme_id, context_text, source_label, captured_at
          FROM word_encounters
          WHERE lexeme_id = ?
          ORDER BY captured_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(lexemeId, limit) as Record<string, unknown>[];

    return rows.map(mapEncounter);
  }
}
