import type {
  DueReviewCard,
  GradeReviewCardInput,
  GradeReviewCardResult,
  ReviewQueueResult,
  ReviewRevealResult,
  ReviewSessionSnapshot,
  ReviewCardState
} from "../domain/models";
import { NotFoundError, ReviewCardNotDueError, UsageError } from "../../lib/errors";
import { nowIso } from "../../lib/time";
import { scheduleReview } from "../../review/scheduler";
import { EventLogRepository } from "../../storage/repositories/event-log-repository";
import { MasteryRepository } from "../../storage/repositories/mastery-repository";
import { ReviewCardRepository } from "../../storage/repositories/review-card-repository";
import { ReviewHistoryRepository } from "../../storage/repositories/review-history-repository";
import { UserPreferenceRepository } from "../../storage/repositories/user-preference-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";

const VALID_GRADES = new Set(["again", "hard", "good", "easy"]);

export class ReviewSessionCore {
  private readonly reviewCards: ReviewCardRepository;
  private readonly preferences: UserPreferenceRepository;
  private readonly mastery: MasteryRepository;
  private readonly history: ReviewHistoryRepository;
  private readonly eventLog: EventLogRepository;

  constructor(private readonly db: SqliteDatabase) {
    this.reviewCards = new ReviewCardRepository(db);
    this.preferences = new UserPreferenceRepository(db);
    this.mastery = new MasteryRepository(db);
    this.history = new ReviewHistoryRepository(db);
    this.eventLog = new EventLogRepository(db);
  }

  getQueue(now?: string, limit?: number): ReviewQueueResult {
    const snapshot = this.getSnapshot(now);
    const items =
      typeof limit === "number" && limit >= 0
        ? snapshot.items.slice(0, limit)
        : snapshot.items;

    return {
      items,
      totalDue: snapshot.totalDue,
      dueReviewCount: snapshot.dueReviewCount,
      dueNewCount: snapshot.dueNewCount,
      returnedCount: items.length
    };
  }

  getNext(now?: string): DueReviewCard | null {
    const snapshot = this.getSnapshot(now);
    return snapshot.items[0] ?? null;
  }

  reveal(cardId: number): ReviewRevealResult {
    const card = this.reviewCards.getById(cardId);

    if (!card) {
      throw new NotFoundError(`Review card ${cardId} was not found.`);
    }

    return { card };
  }

  grade(input: GradeReviewCardInput): GradeReviewCardResult {
    if (!VALID_GRADES.has(input.grade)) {
      throw new UsageError("`grade` requires one of: again, hard, good, easy.");
    }

    const reviewedAt = nowIso(input.reviewedAt);

    return this.db.transaction(() => {
      const card = this.reviewCards.getById(input.cardId);

      if (!card) {
        throw new NotFoundError(`Review card ${input.cardId} was not found.`);
      }

      if (card.dueAt > reviewedAt) {
        throw new ReviewCardNotDueError(
          `Review card ${input.cardId} is not due until ${card.dueAt}.`
        );
      }

      const mastery = this.mastery.getByLexemeId(card.lexemeId);
      const schedule = scheduleReview({
        state: card.state,
        grade: input.grade,
        reviewedAt,
        stability: mastery.stability,
        difficulty: mastery.difficulty
      });
      const updatedCard = this.reviewCards.applyReview(card.id, {
        state: schedule.nextState,
        dueAt: schedule.dueAt,
        updatedAt: reviewedAt
      });
      const updatedMastery = this.mastery.applyReview(card.lexemeId, {
        state: schedule.masteryState,
        stability: schedule.stability,
        difficulty: schedule.difficulty,
        lastReviewedAt: reviewedAt,
        nextDueAt: schedule.dueAt,
        updatedAt: reviewedAt
      });

      this.history.create(
        updatedCard.id,
        input.grade,
        reviewedAt,
        schedule.scheduledDays,
        schedule.stability
      );

      this.eventLog.append(
        "review.graded",
        {
          cardId: updatedCard.id,
          lexemeId: updatedCard.lexemeId,
          grade: input.grade,
          nextState: updatedCard.state,
          nextDueAt: updatedCard.dueAt,
          scheduledDays: schedule.scheduledDays
        },
        reviewedAt
      );

      return {
        card: updatedCard,
        mastery: updatedMastery,
        grade: input.grade,
        scheduledDays: schedule.scheduledDays
      };
    })();
  }

  private getSnapshot(now?: string): ReviewSessionSnapshot {
    const currentTime = nowIso(now);
    const preferences = this.preferences.getDefault();
    const dueReviewStates: ReviewCardState[] = ["learning", "review", "relearning"];
    const dueReviewCount = this.reviewCards.countDue(currentTime, dueReviewStates);
    const dueNewCount = this.reviewCards.countDue(currentTime, ["new"]);
    const reviewItems = this.reviewCards.listDue(
      currentTime,
      dueReviewStates,
      preferences.dailyReviewLimit
    );
    const newItems = this.reviewCards.listDue(
      currentTime,
      ["new"],
      preferences.dailyNewLimit
    );

    return {
      items: [...reviewItems, ...newItems],
      totalDue: dueReviewCount + dueNewCount,
      dueReviewCount,
      dueNewCount
    };
  }
}
