import type {
  AskWordResult,
  CaptureWordResult,
  HomeProjectionResult,
  RescueCandidateResult,
  StatsSummaryResult,
  TeachWordResult
} from "../core/domain/models";
import type {
  ReviewSessionCopy,
  ReviewSessionRunResult
} from "./review-session-runner";
import type { ReturnAfterGapSummary } from "./review-session-feedback";
import {
  ConfigurationError,
  DuplicateEncounterError,
  ExplanationContractError,
  NotFoundError,
  ProviderRequestError,
  ReviewCardNotDueError,
  UsageError
} from "../lib/errors";

function quote(word: string): string {
  return `"${word}"`;
}

function cardCountLabel(count: number): string {
  return `${count} card${count === 1 ? "" : "s"}`;
}

function dayCountLabel(count: number): string {
  return `${count} day${count === 1 ? "" : "s"}`;
}

function trimSentence(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return trimmed;
  }

  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function sentence(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .map(trimSentence)
    .join(" ");
}

function knownStateLine(result: AskWordResult): string | null {
  if (result.knownState) {
    return `In PawMemo it's currently sitting at ${result.knownState}`;
  }

  return "It's still new in PawMemo";
}

export function presentShellCaptureResult(
  result: CaptureWordResult
): string {
  return sentence([
    `I saved ${quote(result.lexeme.lemma)} as ${quote(result.sense.gloss)}`,
    `It's in your study pile now with ${cardCountLabel(result.cards.length)}`,
    "I'll bring it back gently in review"
  ]);
}

export function presentShellAskResult(result: AskWordResult): string {
  return sentence([
    `Here ${quote(result.word)} means ${quote(result.gloss)}`,
    result.explanation,
    result.usageNote,
    knownStateLine(result)
  ]);
}

export function presentShellTeachResult(result: TeachWordResult): string {
  return sentence([
    `I taught ${quote(result.ask.word)} as ${quote(result.ask.gloss)} and tucked it into PawMemo`,
    result.ask.explanation,
    `It's queued with ${cardCountLabel(result.capture.cards.length)} for later review`
  ]);
}

export function presentShellStatsResult(
  summary: StatsSummaryResult,
  home: HomeProjectionResult
): string {
  switch (home.entryKind) {
    case "return_rescue":
      return sentence([
        home.returnGapDays !== null
          ? `You came back after ${dayCountLabel(home.returnGapDays)}`
          : "You're picking this back up after a gap",
        "We do not need the whole pile right now",
        `Let's pull ${quote(home.focusWord ?? "that fading word")} back first`,
        home.optionalNextAction === "review"
          ? "After that, you can stop or do one more"
          : "After that, today's line is connected again"
      ]);
    case "return_review":
      return sentence([
        home.returnGapDays !== null
          ? `You came back after ${dayCountLabel(home.returnGapDays)}`
          : "You're picking this back up after a gap",
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        "One gentle review lap is enough to count as continuing"
      ]);
    case "rescue":
      return sentence([
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        "We do not need the whole pile at once",
        `I'd rescue ${quote(home.focusWord ?? "that fading word")} first`,
        home.optionalNextAction === "review"
          ? "After that, you can stop or do one more"
          : "That one rescue would be enough for now"
      ]);
    case "resume_recent":
      return sentence([
        "You're clear right now with no due cards",
        summary.todayReviewedCount > 0
          ? `You already reviewed ${cardCountLabel(summary.todayReviewedCount)} today`
          : null,
        home.focusWord
          ? `${quote(home.focusWord)} is still the word closest to hand`
          : "You can add a fresh word whenever you want"
      ]);
    case "review":
      return sentence([
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        summary.todayReviewedCount > 0
          ? `You've already reviewed ${cardCountLabel(summary.todayReviewedCount)} today`
          : "One small review lap would be enough",
        home.focusWord ? `${quote(home.focusWord)} is the word closest to hand` : null
      ]);
    case "capture":
      return sentence([
        "You're clear right now with no due cards",
        summary.todayReviewedCount > 0
          ? `You already reviewed ${cardCountLabel(summary.todayReviewedCount)} today`
          : "You can add a fresh word whenever you want"
      ]);
  }
}

export function presentShellReviewIntro(
  summary: StatsSummaryResult
): string {
  if (summary.dueCount === 0) {
    return "You're clear right now. There aren't any due cards waiting.";
  }

  return sentence([
    `You have ${cardCountLabel(summary.dueCount)} due right now`,
    "Let's take them one at a time"
  ]);
}

export function presentShellRescueIntro(
  candidate: RescueCandidateResult,
  home: HomeProjectionResult
): string {
  if (home.entryKind === "return_rescue") {
    return sentence([
      home.returnGapDays !== null
        ? `You do not need the whole pile after ${dayCountLabel(home.returnGapDays)} away`
        : "You do not need the whole pile right now",
      `We'll rescue ${quote(candidate.card.lemma)} first`,
      "Once this one lands, today counts as continuing"
    ]);
  }

  return sentence([
    "Let's not take the whole pile at once",
    `We'll rescue ${quote(candidate.card.lemma)} first`,
    "One gentle lap is enough"
  ]);
}

export function presentShellNoRescueCandidate(
  summary: StatsSummaryResult
): string {
  if (summary.dueCount === 0) {
    return "Nothing needs rescuing right now. You're clear.";
  }

  return sentence([
    "Nothing is in rescue shape right now",
    `You still have ${cardCountLabel(summary.dueCount)} due if you want a normal review lap`
  ]);
}

export function createShellReviewSessionCopy(): ReviewSessionCopy {
  return {
    sessionHeading(limit?: number) {
      const lines: Array<{ text: string; kind: "review-session-heading" | "review-card-field" }> = [
        {
          text: "Okay, here comes a short review lap.",
          kind: "review-session-heading"
        }
      ];

      if (typeof limit === "number") {
        lines.push({
          text: `We'll pause after ${limit} card${limit === 1 ? "" : "s"}.`,
          kind: "review-card-field"
        });
      }

      return lines;
    },
    noDueCards(reviewedCount) {
      return {
        text:
          reviewedCount === 0
            ? "There isn't anything due right now."
            : `That lap is done. We moved through ${cardCountLabel(reviewedCount)}.`,
        kind:
          reviewedCount === 0
            ? "review-session-status-warning"
            : "review-session-status-success"
      };
    },
    sessionPaused(reviewedCount) {
      return {
        text: `Nice. We paused after ${cardCountLabel(reviewedCount)}.`,
        kind: "review-session-status-warning"
      };
    },
    sessionEndedEarly(reviewedCount) {
      return {
        text:
          reviewedCount === 0
            ? "We can pause here before starting."
            : `We can pause here. ${cardCountLabel(reviewedCount)} still moved forward.`,
        kind: "review-session-status-warning"
      };
    },
    cardHeading(card, index) {
      return index === 1
        ? `First up: ${card.lemma}`
        : `Next up: ${card.lemma}`;
    },
    showCardMetadata: false,
    revealPrompt: "Press Enter when you're ready to peek, or type q to pause: ",
    gradePrompt: "How did that feel? [a]gain [h]ard [g]ood [e]asy, or q to pause: ",
    invalidGrade: {
      text: "Give me again, hard, good, easy, or q so I can place it cleanly.",
      kind: "review-session-status-warning"
    },
    answerLine(answerText) {
      return `What we were looking for: ${answerText}`;
    },
    savedGradeResult(result) {
      return {
        text: `Locked in as ${result.grade}. I'll bring it back on ${result.card.dueAt}.`,
        kind: "review-session-status-success"
      };
    }
  };
}

export function presentShellReviewSessionSummary(
  result: ReviewSessionRunResult,
  returnAfterGap: ReturnAfterGapSummary | null,
  options: {
    mode?: "review" | "rescue";
    focusWord?: string | null;
  } = {}
): string {
  if (returnAfterGap) {
    return sentence([
      `You came back after ${returnAfterGap.gapDays} day${returnAfterGap.gapDays === 1 ? "" : "s"} and finished ${cardCountLabel(result.reviewedCount)}`,
      options.focusWord
        ? `${quote(options.focusWord)} is back with you now`
        : "That was enough to reconnect the line",
      returnAfterGap.dueCountAfter > 0
        ? "You can stop there or do one more later"
        : "You're continuing now, not restarting"
    ]);
  }

  if (result.reviewedCount === 0 && !result.quitEarly) {
    return "There wasn't anything waiting, so we can leave it there.";
  }

  if (result.quitEarly) {
    if (options.mode === "rescue" && options.focusWord) {
      return result.reviewedCount === 0
        ? `We can leave ${quote(options.focusWord)} there for now and come back when you're ready.`
        : `${quote(options.focusWord)} still moved a little, and we can leave it there for now.`;
    }

    return result.reviewedCount === 0
      ? "We stopped before doing a card, and that's okay."
      : `We stopped there after ${cardCountLabel(result.reviewedCount)}.`;
  }

  if (options.mode === "rescue") {
    return sentence([
      options.focusWord
        ? `${quote(options.focusWord)} is back with you now`
        : "That rescue landed cleanly",
      "That was the one that mattered most right now",
      "You can stop there or do one more later"
    ]);
  }

  if (result.limitReached) {
    return `Nice. We did ${cardCountLabel(result.reviewedCount)} and paused there.`;
  }

  return `Nice. We finished ${cardCountLabel(result.reviewedCount)} that round.`;
}

export function presentShellError(error: unknown): string {
  if (error instanceof ConfigurationError) {
    if (/API key is missing/i.test(error.message)) {
      return "I need a live model connection before I can handle natural chat. Check `/model`, or set a key there and try again.";
    }

    return `I hit a setup snag. ${trimSentence(error.message)}`;
  }

  if (error instanceof UsageError) {
    const unknownCommandMatch = /^Unknown shell command: (.+)$/.exec(error.message);

    if (unknownCommandMatch) {
      return `I don't know \`/${unknownCommandMatch[1]}\` yet. Try \`/help\` and I'll show you the commands I can handle.`;
    }

    return `I need a little more detail for that. ${trimSentence(error.message)}`;
  }

  if (error instanceof DuplicateEncounterError) {
    return "I already have that word in the pile, so I didn't save it again.";
  }

  if (error instanceof NotFoundError) {
    return `I couldn't find that just now. ${trimSentence(error.message)}`;
  }

  if (error instanceof ReviewCardNotDueError) {
    return "That card is not due yet, so I left it where it is.";
  }

  if (error instanceof ExplanationContractError) {
    return "I couldn't get a clean word explanation to save safely, so I stopped instead of guessing.";
  }

  if (
    error instanceof ProviderRequestError ||
    (error instanceof TypeError && /fetch failed/i.test(error.message))
  ) {
    return "I couldn't reach the model just now. Try again, or check `/model` if the connection looks off.";
  }

  if (error instanceof Error) {
    return `Something slipped while I was handling that. ${trimSentence(error.message)}`;
  }

  return "Something slipped while I was handling that.";
}
