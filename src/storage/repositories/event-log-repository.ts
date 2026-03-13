import type { SqliteDatabase } from "../sqlite/database";

export class EventLogRepository {
  constructor(private readonly db: SqliteDatabase) {}

  append(eventType: string, payload: unknown, timestamp: string): void {
    this.db.prepare(
      `
        INSERT INTO event_log (event_type, payload_json, created_at)
        VALUES (?, ?, ?)
      `
    ).run(eventType, JSON.stringify(payload), timestamp);
  }
}
