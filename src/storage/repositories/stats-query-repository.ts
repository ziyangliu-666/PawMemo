import type {
  MasteryBreakdown,
  MasteryState,
  ReviewCardState
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

const MASTERY_STATES: MasteryState[] = [
  "unknown",
  "seen",
  "familiar",
  "receptive",
  "productive",
  "stable"
];

function emptyMasteryBreakdown(): MasteryBreakdown {
  return {
    unknown: 0,
    seen: 0,
    familiar: 0,
    receptive: 0,
    productive: 0,
    stable: 0
  };
}

export class StatsQueryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  countDue(now: string, states: ReviewCardState[]): number {
    if (states.length === 0) {
      return 0;
    }

    const placeholders = states.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM study_card sc
          JOIN card_learning_state cls ON cls.study_card_id = sc.id
          WHERE cls.state IN (${placeholders}) AND cls.due_at <= ?
            AND sc.lifecycle_state = 'active'
        `
      )
      .get(...states, now) as Record<string, unknown>;

    return Number(row.count);
  }

  countReviewedBetween(startAt: string, endAt: string): number {
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM review_history
          WHERE reviewed_at >= ? AND reviewed_at <= ?
        `
      )
      .get(startAt, endAt) as Record<string, unknown>;

    return Number(row.count);
  }

  countCapturedBetween(startAt: string, endAt: string): number {
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM word_encounters
          WHERE captured_at >= ? AND captured_at <= ?
        `
      )
      .get(startAt, endAt) as Record<string, unknown>;

    return Number(row.count);
  }

  getLastReviewedAt(endAt: string): string | null {
    const row = this.db
      .prepare(
        `
          SELECT reviewed_at
          FROM review_history
          WHERE reviewed_at <= ?
          ORDER BY reviewed_at DESC
          LIMIT 1
        `
      )
      .get(endAt) as Record<string, unknown> | undefined;

    return typeof row?.reviewed_at === "string" ? row.reviewed_at : null;
  }

  getMasteryBreakdown(): MasteryBreakdown {
    const rows = this.db
      .prepare(
        `
          SELECT ems.state, COUNT(*) AS count
          FROM study_entry se
          JOIN entry_memory_state ems ON ems.study_entry_id = se.id
          GROUP BY ems.state
        `
      )
      .all() as Record<string, unknown>[];

    const breakdown = emptyMasteryBreakdown();

    for (const row of rows) {
      const state = row.state;

      if (typeof state === "string" && MASTERY_STATES.includes(state as MasteryState)) {
        breakdown[state as MasteryState] = Number(row.count);
      }
    }

    return breakdown;
  }
}
