import type {
  AppSettingRecord,
  AskWordResult,
  CaptureWordResult,
  DueReviewCard,
  GradeReviewCardResult,
  HomeProjectionResult,
  LlmModelInfo,
  MasteryBreakdown,
  RecoveryProjectionResult,
  RescueCandidateResult,
  ReviewRevealResult,
  ReviewQueueResult,
  StatsSummaryResult,
  TeachWordResult
} from "../core/domain/models";
import type { ReviewSessionRunResult } from "./review-session-runner";
import type { ReturnAfterGapSummary } from "./review-session-feedback";
import type { CompanionPackSummary } from "../companion/types";
import type {
  ListLlmModelsResult,
  LlmStatusSummary
} from "../llm/llm-config-service";

export function formatCaptureResult(result: CaptureWordResult): string {
  const cardTypes = result.cards.map((card) => card.cardType).join(", ");
  const sourceLine = result.encounter.sourceLabel
    ? `Source: ${result.encounter.sourceLabel}`
    : "Source: direct capture";

  return [
    `Captured ${result.lexeme.lemma}`,
    "Context saved.",
    `Gloss: ${result.sense.gloss}`,
    `Mastery: ${result.mastery.state}`,
    `Cards: ${cardTypes}`,
    sourceLine
  ].join("\n");
}

export function formatReviewQueue(result: ReviewQueueResult): string {
  if (result.items.length === 0) {
    return "Due cards: 0";
  }

  const lines = [
    `Due cards: ${result.totalDue}`,
    `Returned: ${result.returnedCount} (review ${result.dueReviewCount}, new ${result.dueNewCount})`
  ];

  for (const item of result.items) {
    lines.push(`[#${item.id}] ${item.lemma} · ${item.cardType} · ${item.state}`);
    lines.push(item.promptText);
    lines.push(`Use: pawmemo grade ${item.id} --grade good`);
  }

  lines.push("Session: pawmemo review session");

  return lines.join("\n");
}

export function formatGradeResult(result: GradeReviewCardResult): string {
  return [
    `Graded card #${result.card.id} (${result.card.lemma})`,
    `Grade: ${result.grade}`,
    `Next state: ${result.card.state}`,
    `Next due: ${result.card.dueAt}`,
    `Mastery: ${result.mastery.state}`,
    `Interval days: ${result.scheduledDays}`
  ].join("\n");
}

export function formatNextReviewCard(card: DueReviewCard | null): string {
  if (!card) {
    return "No due cards.";
  }

  return [
    `Next card: #${card.id} (${card.lemma})`,
    `Type: ${card.cardType}`,
    `State: ${card.state}`,
    card.promptText,
    `Use: pawmemo review reveal ${card.id}`,
    `Then: pawmemo grade ${card.id} --grade good`
  ].join("\n");
}

export function formatReviewReveal(result: ReviewRevealResult): string {
  return [
    `Reveal card #${result.card.id} (${result.card.lemma})`,
    `Prompt: ${result.card.promptText}`,
    `Answer: ${result.card.answerText}`,
    `State: ${result.card.state}`,
    `Use: pawmemo grade ${result.card.id} --grade good`
  ].join("\n");
}

function formatOverdueLabel(result: RescueCandidateResult): string {
  if (result.overdueDays >= 1) {
    return `${result.overdueDays} day${result.overdueDays === 1 ? "" : "s"}`;
  }

  if (result.overdueHours >= 1) {
    return `${result.overdueHours} hour${result.overdueHours === 1 ? "" : "s"}`;
  }

  return `${result.overdueMinutes} minute${result.overdueMinutes === 1 ? "" : "s"}`;
}

function quoteWord(word: string): string {
  return `"${word}"`;
}

function formatOptionalNextAction(result: HomeProjectionResult): string | null {
  switch (result.optionalNextAction) {
    case "review":
      return "review one more";
    case "capture":
      return "bring in one new word";
    default:
      return null;
  }
}

function buildHomeNarrativeLines(result: HomeProjectionResult): string[] {
  const focusWord = result.focusWord ? quoteWord(result.focusWord) : "that fading word";

  switch (result.entryKind) {
    case "return_rescue":
      return [
        `Today: rescue ${focusWord} first`,
        "Pace: do not take the whole pile at once",
        `After this: once ${focusWord} is back, today counts as reconnected`
      ];
    case "return_review":
      return [
        "Today: take one gentle review lap",
        "Pace: you do not need the whole pile today",
        "After this: one card is enough to count as continuing"
      ];
    case "rescue":
      return [
        `Today: rescue ${focusWord} first`,
        "Pace: one fading word before the rest",
        "After this: you can stop there or keep going"
      ];
    case "resume_recent":
      return [
        `Today: pick up ${result.focusWord ? quoteWord(result.focusWord) : "that word"} again or bring one new word`,
        "Pace: the pile is clear right now"
      ];
    case "review": {
      const lines = [
        "Today: take one short review lap",
        "Pace: one card at a time"
      ];

      if (result.focusWord) {
        lines.push(`Watching: ${quoteWord(result.focusWord)}`);
      }

      return lines;
    }
    case "capture":
      return [
        "Today: bring one new word home",
        "Pace: the pile is clear right now"
      ];
  }
}

export function formatRescueCandidate(result: RescueCandidateResult | null): string {
  if (!result) {
    return "No rescue candidates.";
  }

  return [
    "Rescue",
    `Card: #${result.card.id} (${result.card.lemma})`,
    `State: ${result.card.state}`,
    `Overdue: ${formatOverdueLabel(result)}`,
    result.card.promptText
  ].join("\n");
}

export function formatReviewSessionSummary(result: ReviewSessionRunResult): string {
  const outcome =
    result.reviewedCount === 0 && !result.quitEarly
      ? "empty"
      : result.quitEarly
        ? "quit"
        : result.limitReached
          ? "paused"
          : "complete";

  return [
    "Session summary",
    `Outcome: ${outcome}`,
    `Reviewed: ${result.reviewedCount}`,
    `Grades: again ${result.gradeCounts.again}, hard ${result.gradeCounts.hard}, good ${result.gradeCounts.good}, easy ${result.gradeCounts.easy}`
  ].join("\n");
}

export function formatReturnAfterGapSummary(
  summary: ReturnAfterGapSummary
): string {
  return [
    "Return after gap",
    `Last review: ${summary.lastReviewedAt}`,
    `Gap: ${summary.gapDays} day${summary.gapDays === 1 ? "" : "s"}`,
    `Reviewed now: ${summary.reviewedCount}`,
    `Due: ${summary.dueCountBefore} -> ${summary.dueCountAfter}`
  ].join("\n");
}

export function formatAskResult(result: AskWordResult): string {
  return [
    `Word: ${result.word}`,
    `Gloss: ${result.gloss}`,
    `Explanation: ${result.explanation}`,
    `Usage note: ${result.usageNote}`,
    `Confidence: ${result.confidenceNote}`,
    `Known state: ${result.knownState ?? "new to PawMemo"}`,
    `Retrieved gloss: ${result.retrievedGloss ?? "none"}`,
    `Provider: ${result.provider} (${result.model})`
  ].join("\n");
}

export function formatSettings(
  settings: AppSettingRecord[],
  apiKeyPresent: boolean
): string {
  const lines = settings.map((setting) => `${setting.key}: ${setting.value}`);
  lines.push(`api_key_present: ${apiKeyPresent ? "yes" : "no"}`);
  return lines.join("\n");
}

export function formatLlmStatus(summary: LlmStatusSummary): string {
  const lines = [
    "LLM",
    `Current: ${summary.provider} (${summary.model})`,
    "Providers:"
  ];

  for (const provider of summary.providers) {
    const marker = provider.selected ? "*" : " ";
    const apiUrl = provider.apiUrl ? ` · url ${provider.apiUrl}` : "";
    lines.push(
      `${marker} ${provider.provider} · model ${provider.model} · api key ${provider.apiKeyPresent ? "yes" : "no"}${apiUrl}`
    );
  }

  lines.push("Use: /model");
  lines.push("Use: /model list [provider]");
  lines.push("Use: /model use <provider> [model] [--api-key KEY] [--api-url URL]");
  lines.push("Use: /model key <provider> <api-key>");
  lines.push("Use: /model url <provider> <api-url>");

  return lines.join("\n");
}

function formatModelLine(
  model: LlmModelInfo,
  currentModel: string
): string {
  const marker = model.id === currentModel ? "*" : " ";
  const ownedBy = model.ownedBy ? ` · ${model.ownedBy}` : "";
  return `${marker} ${model.id}${ownedBy}`;
}

export function formatLlmModelList(result: ListLlmModelsResult): string {
  const lines = [
    `Models (${result.provider})`,
    `Current model: ${result.currentModel}`
  ];

  if (result.models.length === 0) {
    lines.push("No models returned by the provider.");
    return lines.join("\n");
  }

  for (const model of result.models) {
    lines.push(formatModelLine(model, result.currentModel));
  }

  return lines.join("\n");
}

export function formatCompanionPacks(
  packs: CompanionPackSummary[],
  activePackId: string
): string {
  const lines = ["Companion packs:"];

  for (const pack of packs) {
    const activeMarker = pack.id === activePackId ? "*" : " ";
    const archetype = pack.archetype ? ` / ${pack.archetype}` : "";
    lines.push(
      `${activeMarker} ${pack.id} (${pack.displayName})${archetype}`
    );
  }

  return lines.join("\n");
}

export function formatTeachResult(result: TeachWordResult): string {
  const cardTypes = result.capture.cards.map((card) => card.cardType).join(", ");

  return [
    `Word: ${result.ask.word}`,
    `Gloss: ${result.ask.gloss}`,
    `Explanation: ${result.ask.explanation}`,
    `Usage note: ${result.ask.usageNote}`,
    `Known state before save: ${result.ask.knownState ?? "new to PawMemo"}`,
    "Saved to PawMemo.",
    `Mastery: ${result.capture.mastery.state}`,
    `Cards: ${cardTypes}`,
    `Source: ${result.capture.encounter.sourceLabel ?? "direct capture"}`
  ].join("\n");
}

function formatMasteryBreakdown(breakdown: MasteryBreakdown): string[] {
  return [
    `  unknown: ${breakdown.unknown}`,
    `  seen: ${breakdown.seen}`,
    `  familiar: ${breakdown.familiar}`,
    `  receptive: ${breakdown.receptive}`,
    `  productive: ${breakdown.productive}`,
    `  stable: ${breakdown.stable}`
  ];
}

export function formatStatsResult(result: StatsSummaryResult): string {
  return [
    "Stats",
    `Generated: ${result.generatedAt}`,
    `Today reviewed: ${result.todayReviewedCount}`,
    `Due now: ${result.dueCount} (review ${result.dueReviewCount}, new ${result.dueNewCount})`,
    `Last 7 days: captured ${result.capturedLast7Days}, reviewed ${result.reviewedLast7Days}`,
    "Mastery",
    ...formatMasteryBreakdown(result.masteryBreakdown)
  ].join("\n");
}

export function formatRecoveryProjection(
  result: RecoveryProjectionResult
): string {
  const lines = ["Recovery"];

  if (result.lastReviewedAt) {
    lines.push(`Last review: ${result.lastReviewedAt}`);
  } else {
    lines.push("Last review: none yet");
  }

  lines.push(`Prior history: ${result.hasPriorReviewHistory ? "yes" : "no"}`);

  lines.push(`Return after gap: ${result.isReturnAfterGap ? "yes" : "no"}`);

  if (result.returnGapDays !== null) {
    lines.push(
      `Return gap: ${result.returnGapDays} day${result.returnGapDays === 1 ? "" : "s"}`
    );
  }

  lines.push(`Rescue ready: ${result.rescueCandidate ? "yes" : "no"}`);

  if (result.rescueCandidate) {
    lines.push(
      `Rescue next: #${result.rescueCandidate.card.id} (${result.rescueCandidate.card.lemma})`
    );
    lines.push(
      `Rescue overdue: ${formatOverdueLabel(result.rescueCandidate)}`
    );
  }

  return lines.join("\n");
}

export function formatHomeProjection(result: HomeProjectionResult): string {
  const lines = ["Home"];
  const optionalNextAction = formatOptionalNextAction(result);

  lines.push(...buildHomeNarrativeLines(result));

  if (optionalNextAction) {
    lines.push(`Optional next: ${optionalNextAction}`);
  }

  lines.push(`Due now: ${result.dueCount}`);

  if (result.returnGapDays !== null) {
    lines.push(
      `Gap carried in: ${result.returnGapDays} day${result.returnGapDays === 1 ? "" : "s"}`
    );
  }

  return lines.join("\n");
}
