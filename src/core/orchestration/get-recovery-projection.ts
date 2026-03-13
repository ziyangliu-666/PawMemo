import type { RecoveryProjectionResult } from "../domain/models";
import { GetCompanionSignalsService } from "./get-companion-signals";
import { evaluateRecoveryPolicy } from "./recovery-policy";
import { RescueService } from "./rescue-service";
import type { SqliteDatabase } from "../../storage/sqlite/database";

export class GetRecoveryProjectionService {
  private readonly companionSignals: GetCompanionSignalsService;
  private readonly rescueService: RescueService;

  constructor(db: SqliteDatabase) {
    this.companionSignals = new GetCompanionSignalsService(db);
    this.rescueService = new RescueService(db);
  }

  getProjection(at?: string): RecoveryProjectionResult {
    const signals = this.companionSignals.getSignals(at);
    const rescueCandidate = this.rescueService.getCandidate(at);
    const policy = evaluateRecoveryPolicy({
      lastReviewedAt: signals.lastReviewedAt,
      hoursSinceLastReview: signals.hoursSinceLastReview
    });

    return {
      generatedAt: signals.generatedAt,
      lastReviewedAt: signals.lastReviewedAt,
      hasPriorReviewHistory: policy.hasPriorReviewHistory,
      isReturnAfterGap: policy.isReturnAfterGap,
      returnGapDays: policy.isReturnAfterGap ? signals.daysSinceLastReview : null,
      returnGapHours: policy.isReturnAfterGap ? signals.hoursSinceLastReview : null,
      daysSinceLastReview: signals.daysSinceLastReview,
      rescueCandidate
    };
  }
}
