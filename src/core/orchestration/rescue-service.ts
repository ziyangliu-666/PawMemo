import type { RescueCandidateResult, ReviewCardState } from "../domain/models";
import { nowIso } from "../../lib/time";
import { ReviewCardRepository } from "../../storage/repositories/review-card-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";

const RESCUE_STATES: ReviewCardState[] = ["review", "relearning"];

function computeOverdueMinutes(dueAt: string, currentTime: string): number {
  const diffMs = new Date(currentTime).getTime() - new Date(dueAt).getTime();
  return Math.max(0, Math.floor(diffMs / 60_000));
}

export class RescueService {
  private readonly reviewCards: ReviewCardRepository;

  constructor(db: SqliteDatabase) {
    this.reviewCards = new ReviewCardRepository(db);
  }

  getCandidate(now?: string): RescueCandidateResult | null {
    const currentTime = nowIso(now);
    const card = this.reviewCards.listDue(currentTime, RESCUE_STATES, 1)[0] ?? null;

    if (!card) {
      return null;
    }

    const overdueMinutes = computeOverdueMinutes(card.dueAt, currentTime);

    return {
      card,
      overdueMinutes,
      overdueHours: Number((overdueMinutes / 60).toFixed(1)),
      overdueDays: Number((overdueMinutes / 1_440).toFixed(1))
    };
  }
}
