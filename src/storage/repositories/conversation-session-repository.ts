import type {
  ConversationSessionRecord,
  ConversationSessionStatus
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function mapSession(row: Record<string, unknown>): ConversationSessionRecord {
  const rawEndedAt = row.ended_at;
  const endedAt =
    rawEndedAt === null || rawEndedAt === undefined
      ? null
      : typeof rawEndedAt === "string"
        ? rawEndedAt
        : typeof rawEndedAt === "number" || typeof rawEndedAt === "boolean"
          ? String(rawEndedAt)
          : null;

  return {
    id: Number(row.id),
    channel: String(row.channel),
    activePackId: String(row.active_pack_id),
    status: String(row.status) as ConversationSessionStatus,
    startedAt: String(row.started_at),
    endedAt
  };
}

export class ConversationSessionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: {
    channel: string;
    activePackId: string;
    startedAt: string;
  }): ConversationSessionRecord {
    const result = this.db.prepare(
      `
        INSERT INTO conversation_sessions (
          channel,
          active_pack_id,
          status,
          started_at,
          ended_at
        )
        VALUES (@channel, @activePackId, 'active', @startedAt, NULL)
      `
    ).run(input);

    return this.getById(Number(result.lastInsertRowid));
  }

  getById(id: number): ConversationSessionRecord {
    const row = this.db.prepare(
      `
        SELECT id, channel, active_pack_id, status, started_at, ended_at
        FROM conversation_sessions
        WHERE id = ?
      `
    ).get(id) as Record<string, unknown> | undefined;

    if (!row) {
      throw new Error(`Conversation session ${id} not found.`);
    }

    return mapSession(row);
  }

  end(sessionId: number, endedAt: string): ConversationSessionRecord {
    this.db.prepare(
      `
        UPDATE conversation_sessions
        SET status = 'ended',
            ended_at = @endedAt
        WHERE id = @sessionId
      `
    ).run({
      sessionId,
      endedAt
    });

    return this.getById(sessionId);
  }
}
