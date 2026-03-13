import type { CompanionEvent } from "../companion/types";
import type { CompanionSignalsResult } from "../core/domain/models";
import { evaluateRecoveryPolicy } from "../core/orchestration/recovery-policy";
import type { ReviewSessionRunResult } from "./review-session-runner";

export interface ReturnAfterGapSummary {
  lastReviewedAt: string;
  gapDays: number;
  reviewedCount: number;
  dueCountBefore: number;
  dueCountAfter: number;
}

export function buildReturnAfterGapSummary(
  signalsBefore: CompanionSignalsResult,
  signalsAfter: CompanionSignalsResult,
  result: ReviewSessionRunResult
): ReturnAfterGapSummary | null {
  if (result.reviewedCount <= 0) {
    return null;
  }

  if (
    !evaluateRecoveryPolicy({
      lastReviewedAt: signalsBefore.lastReviewedAt,
      hoursSinceLastReview: signalsBefore.hoursSinceLastReview
    }).isReturnAfterGap ||
    !signalsBefore.lastReviewedAt ||
    signalsBefore.daysSinceLastReview === null
  ) {
    return null;
  }

  return {
    lastReviewedAt: signalsBefore.lastReviewedAt,
    gapDays: signalsBefore.daysSinceLastReview,
    reviewedCount: result.reviewedCount,
    dueCountBefore: signalsBefore.dueCount,
    dueCountAfter: signalsAfter.dueCount
  };
}

export function buildReviewSessionCompanionEvent(
  result: ReviewSessionRunResult,
  returnAfterGap: ReturnAfterGapSummary | null
): CompanionEvent {
  if (returnAfterGap) {
    return {
      type: "return_after_gap",
      reviewedCount: result.reviewedCount,
      gapDays: returnAfterGap.gapDays
    };
  }

  if (result.reviewedCount === 0 && !result.quitEarly) {
    return { type: "review_session_empty" };
  }

  if (result.quitEarly) {
    return {
      type: "review_session_quit",
      reviewedCount: result.reviewedCount
    };
  }

  if (result.limitReached) {
    return {
      type: "review_session_paused",
      reviewedCount: result.reviewedCount
    };
  }

  return {
    type: "review_session_complete",
    reviewedCount: result.reviewedCount
  };
}
