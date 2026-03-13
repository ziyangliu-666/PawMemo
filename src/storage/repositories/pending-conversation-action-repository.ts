import type { PendingConversationActionRecord } from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function mapPendingAction(
  row: Record<string, unknown>
): PendingConversationActionRecord {
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    actionKind: String(row.action_kind),
    payloadJson: String(row.payload_json),
    promptText: String(row.prompt_text),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class PendingConversationActionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getBySession(sessionId: number): PendingConversationActionRecord | null {
    const row = this.db.prepare(
      `
        SELECT
          id,
          session_id,
          action_kind,
          payload_json,
          prompt_text,
          created_at,
          updated_at
        FROM pending_conversation_actions
        WHERE session_id = ?
      `
    ).get(sessionId) as Record<string, unknown> | undefined;

    return row ? mapPendingAction(row) : null;
  }

  upsert(input: {
    sessionId: number;
    actionKind: string;
    payloadJson: string;
    promptText: string;
    createdAt: string;
    updatedAt: string;
  }): PendingConversationActionRecord {
    this.db.prepare(
      `
        INSERT INTO pending_conversation_actions (
          session_id,
          action_kind,
          payload_json,
          prompt_text,
          created_at,
          updated_at
        )
        VALUES (
          @sessionId,
          @actionKind,
          @payloadJson,
          @promptText,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(session_id) DO UPDATE SET
          action_kind = excluded.action_kind,
          payload_json = excluded.payload_json,
          prompt_text = excluded.prompt_text,
          updated_at = excluded.updated_at
      `
    ).run(input);

    return this.getBySession(input.sessionId) as PendingConversationActionRecord;
  }

  clear(sessionId: number): void {
    this.db.prepare(
      `
        DELETE FROM pending_conversation_actions
        WHERE session_id = ?
      `
    ).run(sessionId);
  }
}
