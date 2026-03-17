import type { ReviewGrade } from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

export class ReviewHistoryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(
    studyCardId: number,
    grade: ReviewGrade,
    reviewedAt: string,
    scheduledDays: number,
    stabilityAfter: number
  ): void {
    this.db.prepare(
      `
        INSERT INTO review_history (
          study_card_id,
          grade,
          reviewed_at,
          scheduled_days,
          stability_after
        )
        VALUES (?, ?, ?, ?, ?)
      `
    ).run(studyCardId, grade, reviewedAt, scheduledDays, stabilityAfter);
  }
}
