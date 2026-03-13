import type { SqliteDatabase } from "../sqlite/database";

export interface UserPreferenceRecord {
  id: number;
  userId: number;
  dailyNewLimit: number;
  dailyReviewLimit: number;
  companionStyle: string;
  createdAt: string;
  updatedAt: string;
}

function mapPreference(row: Record<string, unknown>): UserPreferenceRecord {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    dailyNewLimit: Number(row.daily_new_limit),
    dailyReviewLimit: Number(row.daily_review_limit),
    companionStyle: String(row.companion_style),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class UserPreferenceRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getDefault(): UserPreferenceRecord {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            user_id,
            daily_new_limit,
            daily_review_limit,
            companion_style,
            created_at,
            updated_at
          FROM user_preferences
          WHERE id = 1
        `
      )
      .get() as Record<string, unknown>;

    return mapPreference(row);
  }
}
