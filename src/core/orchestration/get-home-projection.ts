import type {
  HomeEntryKind,
  HomeFocusReason,
  HomeProjectionResult,
  SuggestedNextAction
} from "../domain/models";
import { GetCompanionSignalsService } from "./get-companion-signals";
import { GetRecoveryProjectionService } from "./get-recovery-projection";
import type { SqliteDatabase } from "../../storage/sqlite/database";

export class GetHomeProjectionService {
  private readonly companionSignals: GetCompanionSignalsService;
  private readonly recoveryProjection: GetRecoveryProjectionService;

  constructor(db: SqliteDatabase) {
    this.companionSignals = new GetCompanionSignalsService(db);
    this.recoveryProjection = new GetRecoveryProjectionService(db);
  }

  getProjection(at?: string): HomeProjectionResult {
    const signals = this.companionSignals.getSignals(at);
    const recovery = this.recoveryProjection.getProjection(at);
    const focusWord = recovery.rescueCandidate?.card.lemma ?? signals.recentWord;
    const focusReason: HomeFocusReason = recovery.rescueCandidate
      ? "rescue"
      : signals.recentWord
        ? "recent"
        : null;
    const entryKind = resolveEntryKind({
      dueCount: signals.dueCount,
      hasRescueCandidate: recovery.rescueCandidate !== null,
      isReturnAfterGap: recovery.isReturnAfterGap,
      recentWord: signals.recentWord
    });

    return {
      generatedAt: signals.generatedAt,
      dueCount: signals.dueCount,
      recentWord: signals.recentWord,
      focusWord,
      focusReason,
      hasPriorReviewHistory: recovery.hasPriorReviewHistory,
      isReturnAfterGap: recovery.isReturnAfterGap,
      returnGapDays: recovery.returnGapDays,
      rescueCandidate: recovery.rescueCandidate,
      entryKind,
      suggestedNextAction: resolveSuggestedNextAction(entryKind),
      canStopAfterPrimaryAction: resolvesCanStopAfterPrimaryAction(entryKind),
      optionalNextAction: resolveOptionalNextAction(entryKind, signals.dueCount)
    };
  }
}

function resolveEntryKind(input: {
  dueCount: number;
  hasRescueCandidate: boolean;
  isReturnAfterGap: boolean;
  recentWord: string | null;
}): HomeEntryKind {
  if (input.hasRescueCandidate && input.isReturnAfterGap) {
    return "return_rescue";
  }

  if (input.hasRescueCandidate) {
    return "rescue";
  }

  if (input.isReturnAfterGap && input.dueCount > 0) {
    return "return_review";
  }

  if (input.dueCount > 0) {
    return "review";
  }

  if (input.recentWord) {
    return "resume_recent";
  }

  return "capture";
}

function resolveSuggestedNextAction(entryKind: HomeEntryKind): SuggestedNextAction {
  if (entryKind === "return_rescue" || entryKind === "rescue") {
    return "rescue";
  }

  if (entryKind === "return_review" || entryKind === "review") {
    return "review";
  }

  return "capture";
}

function resolvesCanStopAfterPrimaryAction(entryKind: HomeEntryKind): boolean {
  return entryKind === "return_rescue" || entryKind === "return_review" || entryKind === "rescue";
}

function resolveOptionalNextAction(
  entryKind: HomeEntryKind,
  dueCount: number
): SuggestedNextAction | null {
  if (
    (entryKind === "return_rescue" ||
      entryKind === "return_review" ||
      entryKind === "rescue") &&
    dueCount > 1
  ) {
    return "review";
  }

  if (entryKind === "resume_recent") {
    return "capture";
  }

  return null;
}
