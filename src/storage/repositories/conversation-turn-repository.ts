import type {
  ConversationSpeaker,
  ConversationTurnKind,
  ConversationTurnRecord
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function mapTurn(row: Record<string, unknown>): ConversationTurnRecord {
  const rawPayloadJson = row.payload_json;
  const payloadJson =
    rawPayloadJson === null || rawPayloadJson === undefined
      ? null
      : typeof rawPayloadJson === "string"
        ? rawPayloadJson
        : typeof rawPayloadJson === "number" || typeof rawPayloadJson === "boolean"
          ? String(rawPayloadJson)
          : null;

  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    turnIndex: Number(row.turn_index),
    speaker: String(row.speaker) as ConversationSpeaker,
    kind: String(row.kind) as ConversationTurnKind,
    contentText: String(row.content_text),
    payloadJson,
    createdAt: String(row.created_at)
  };
}

export class ConversationTurnRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(input: {
    sessionId: number;
    speaker: ConversationSpeaker;
    kind: ConversationTurnKind;
    contentText: string;
    payloadJson?: string | null;
    createdAt: string;
  }): ConversationTurnRecord {
    const turnIndexRow = this.db.prepare(
      `
        SELECT COALESCE(MAX(turn_index), 0) AS max_turn_index
        FROM conversation_turns
        WHERE session_id = ?
      `
    ).get(input.sessionId) as Record<string, unknown>;
    const nextTurnIndex = Number(turnIndexRow.max_turn_index ?? 0);

    const result = this.db.prepare(
      `
        INSERT INTO conversation_turns (
          session_id,
          turn_index,
          speaker,
          kind,
          content_text,
          payload_json,
          created_at
        )
        VALUES (
          @sessionId,
          @turnIndex,
          @speaker,
          @kind,
          @contentText,
          @payloadJson,
          @createdAt
        )
      `
    ).run({
      ...input,
      turnIndex: nextTurnIndex + 1,
      payloadJson: input.payloadJson ?? null
    });

    return this.getById(Number(result.lastInsertRowid));
  }

  listBySession(sessionId: number): ConversationTurnRecord[] {
    const rows = this.db.prepare(
      `
        SELECT
          id,
          session_id,
          turn_index,
          speaker,
          kind,
          content_text,
          payload_json,
          created_at
        FROM conversation_turns
        WHERE session_id = ?
        ORDER BY turn_index ASC
      `
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map(mapTurn);
  }

  private getById(id: number): ConversationTurnRecord {
    const row = this.db.prepare(
      `
        SELECT
          id,
          session_id,
          turn_index,
          speaker,
          kind,
          content_text,
          payload_json,
          created_at
        FROM conversation_turns
        WHERE id = ?
      `
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`Conversation turn ${id} not found.`);
    }

    return mapTurn(row);
  }
}
