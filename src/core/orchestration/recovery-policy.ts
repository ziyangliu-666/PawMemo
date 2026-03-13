export const RETURN_AFTER_GAP_THRESHOLD_HOURS = 24 * 7;

export interface RecoveryPolicyInput {
  lastReviewedAt: string | null;
  hoursSinceLastReview: number | null;
}

export interface RecoveryPolicyResult {
  hasPriorReviewHistory: boolean;
  isReturnAfterGap: boolean;
}

export function evaluateRecoveryPolicy(
  input: RecoveryPolicyInput
): RecoveryPolicyResult {
  const hasPriorReviewHistory = input.lastReviewedAt !== null;
  const isReturnAfterGap =
    hasPriorReviewHistory &&
    input.hoursSinceLastReview !== null &&
    input.hoursSinceLastReview >= RETURN_AFTER_GAP_THRESHOLD_HOURS;

  return {
    hasPriorReviewHistory,
    isReturnAfterGap
  };
}
