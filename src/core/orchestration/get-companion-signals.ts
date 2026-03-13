import type { CompanionSignalsResult } from "../domain/models";
import { addDays, nowIso, startOfUtcDay } from "../../lib/time";
import { StatsQueryRepository } from "../../storage/repositories/stats-query-repository";
import { WordQueryRepository } from "../../storage/repositories/word-query-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";

export class GetCompanionSignalsService {
  private readonly statsQuery: StatsQueryRepository;
  private readonly wordQuery: WordQueryRepository;

  constructor(db: SqliteDatabase) {
    this.statsQuery = new StatsQueryRepository(db);
    this.wordQuery = new WordQueryRepository(db);
  }

  getSignals(at?: string): CompanionSignalsResult {
    const generatedAt = nowIso(at);
    const todayStart = startOfUtcDay(generatedAt);
    const sevenDayStart = addDays(todayStart, -6);
    const dueReviewCount = this.statsQuery.countDue(generatedAt, [
      "learning",
      "review",
      "relearning"
    ]);
    const dueNewCount = this.statsQuery.countDue(generatedAt, ["new"]);
    const masteryBreakdown = this.statsQuery.getMasteryBreakdown();
    const lastReviewedAt = this.statsQuery.getLastReviewedAt(generatedAt);

    return {
      generatedAt,
      dueCount: dueReviewCount + dueNewCount,
      dueReviewCount,
      dueNewCount,
      recentWord: this.wordQuery.listRecentWords(1)[0] ?? null,
      todayReviewedCount: this.statsQuery.countReviewedBetween(todayStart, generatedAt),
      capturedLast7Days: this.statsQuery.countCapturedBetween(sevenDayStart, generatedAt),
      reviewedLast7Days: this.statsQuery.countReviewedBetween(sevenDayStart, generatedAt),
      masteryBreakdown,
      stableCount: masteryBreakdown.stable,
      lastReviewedAt,
      hoursSinceLastReview: resolveHoursSinceLastReview(lastReviewedAt, generatedAt),
      daysSinceLastReview: resolveDaysSinceLastReview(lastReviewedAt, generatedAt)
    };
  }
}

function resolveHoursSinceLastReview(
  lastReviewedAt: string | null,
  generatedAt: string
): number | null {
  if (!lastReviewedAt) {
    return null;
  }

  const elapsedMs = Math.max(
    0,
    new Date(generatedAt).getTime() - new Date(lastReviewedAt).getTime()
  );

  return Math.floor(elapsedMs / 3_600_000);
}

function resolveDaysSinceLastReview(
  lastReviewedAt: string | null,
  generatedAt: string
): number | null {
  const hoursSinceLastReview = resolveHoursSinceLastReview(lastReviewedAt, generatedAt);
  return hoursSinceLastReview === null ? null : Math.floor(hoursSinceLastReview / 24);
}
