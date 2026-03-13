import type {
  DueReviewCard,
  GradeReviewCardInput,
  GradeReviewCardResult,
  GetReviewQueueInput,
  ReviewQueueResult,
  ReviewRevealResult
} from "../domain/models";
import { ReviewSessionCore } from "../review-session/review-session-core";
import type { SqliteDatabase } from "../../storage/sqlite/database";

export class ReviewService {
  private readonly session: ReviewSessionCore;

  constructor(db: SqliteDatabase) {
    this.session = new ReviewSessionCore(db);
  }

  getQueue(input: GetReviewQueueInput = {}): ReviewQueueResult {
    return this.session.getQueue(input.now, input.limit);
  }

  getNext(now?: string): DueReviewCard | null {
    return this.session.getNext(now);
  }

  reveal(cardId: number): ReviewRevealResult {
    return this.session.reveal(cardId);
  }

  grade(input: GradeReviewCardInput): GradeReviewCardResult {
    return this.session.grade(input);
  }
}
