import type {
  AskWordResult,
  CaptureWordResult,
  CompanionSignalsResult,
  DueReviewCard,
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
  CardSelectionError,
  CardAuthorContractError,
  ConfigurationError,
  DuplicateEncounterError,
  ExplanationContractError,
  NotFoundError,
  ProviderRequestError,
  ReviewCardNotDueError,
  UsageError
} from "../lib/errors";

export interface ShellStartupIntroOptions {
  hasUsableProviderApiKey?: boolean;
}

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
  if (result.responseLanguage === "zh") {
    return sentence([
      `这里的 ${quote(result.word)} 主要是指 ${quote(result.gloss)}`,
      result.highlights.length > 0 ? `重点先看 ${result.highlights.join("、")}` : null
    ]);
  }

  return sentence([
    `Here ${quote(result.word)} mainly means ${quote(result.gloss)}`,
    result.highlights.length > 0
      ? `The key bits are ${result.highlights.join(", ")}`
      : null
  ]);
}

export function presentShellTeachResult(result: TeachWordResult): string {
  return sentence([
    `I taught ${quote(result.ask.word)} as ${quote(result.ask.gloss)} and tucked it into PawMemo`,
    result.ask.explanation,
    `It's queued with ${cardCountLabel(result.capture.cards.length)} for later review`
  ]);
}

export function presentShellCardListResult(cards: DueReviewCard[], word?: string): string {
  if (cards.length === 0) {
    return word
      ? `I couldn't find any cards for ${quote(word)} just now.`
      : "I couldn't find any cards in that view just now.";
  }

  if (word) {
    return sentence([
      `I found ${cardCountLabel(cards.length)} for ${quote(word)}`,
      "I'll keep the list compact"
    ]);
  }

  return sentence([
    `I found ${cardCountLabel(cards.length)} in the workspace`,
    "I'll keep the list compact"
  ]);
}

export function presentShellCardMutationResult(options: {
  operation: "create" | "update" | "pause" | "resume" | "archive" | "delete";
  card: DueReviewCard;
}): string {
  const target = `card #${options.card.id} for ${quote(options.card.lemma)}`;

  switch (options.operation) {
    case "create":
      return `I added ${target}.`;
    case "update":
      return `I updated ${target}.`;
    case "pause":
      return `I paused ${target}.`;
    case "resume":
      return `I put ${target} back into the active pile.`;
    case "archive":
      return `I archived ${target}.`;
    case "delete":
      return `I deleted ${target}.`;
  }
}

export function presentShellStartupIntro(
  summary: CompanionSignalsResult,
  home: HomeProjectionResult,
  options: ShellStartupIntroOptions = {}
): string | null {
  const hasUsableProviderApiKey = options.hasUsableProviderApiKey ?? false;

  switch (home.entryKind) {
    case "return_rescue":
      return sentence([
        home.returnGapDays !== null
          ? `Welcome back after ${dayCountLabel(home.returnGapDays)}`
          : "Welcome back",
        `We'll rescue ${quote(home.focusWord ?? "that fading word")} first`,
        home.optionalNextAction === "review"
          ? "After that, you can stop or do one more"
          : "That one gentle rescue is enough for today"
      ]);
    case "return_review":
      return sentence([
        home.returnGapDays !== null
          ? `Welcome back after ${dayCountLabel(home.returnGapDays)}`
          : "Welcome back",
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        "One short review lap is enough to reconnect the line"
      ]);
    case "rescue":
      return sentence([
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        `We'll rescue ${quote(home.focusWord ?? "that fading word")} first`,
        "You do not need the whole pile at once"
      ]);
    case "resume_recent":
      return sentence([
        home.focusWord
          ? `${quote(home.focusWord)} is still close to hand`
          : "You're clear right now",
        "We can pick it up again or bring in one new word"
      ]);
    case "review":
      return sentence([
        `You have ${cardCountLabel(summary.dueCount)} due right now`,
        "One short review lap would be enough"
      ]);
    case "capture":
      return hasUsableProviderApiKey
        ? sentence([
            "You're starting fresh, so one tiny word is enough",
            "Save one with `/capture ...`, or open `/help` if you want a quick tour"
          ])
        : sentence([
            "You're starting fresh, and one tiny word is enough",
            "Save one with `/capture ...`, or open `/help` if you want a quick tour",
            "When you want free chat, ask, and teach, wake them up with `/models`"
          ]);
  }
}

export function presentShellPlannerSetupGuidance(
  home: HomeProjectionResult,
  options: {
    hasAnyUsableProviderApiKey?: boolean;
  } = {}
): string {
  const hasAnyUsableProviderApiKey = options.hasAnyUsableProviderApiKey ?? false;
  const setupLine = hasAnyUsableProviderApiKey
    ? "Use `/models` if you want me to switch back onto a provider that already has a key."
    : "Use `/models` when you want free chat, ask, and teach to wake up.";

  switch (home.entryKind) {
    case "return_rescue":
    case "rescue":
      return sentence([
        home.focusWord
          ? `${quote(home.focusWord)} is still the one I'd keep closest`
          : "The fading card is still the one I'd keep closest",
        "We can still use `/rescue`, `/review`, `/stats`, and `/pet` right now",
        setupLine
      ]);
    case "return_review":
    case "review":
      return sentence([
        `You still have ${cardCountLabel(home.dueCount)} waiting`,
        "We can still use `/review`, `/stats`, and `/pet` right now",
        setupLine
      ]);
    case "resume_recent":
      return sentence([
        home.focusWord
          ? `${quote(home.focusWord)} is still close to hand`
          : "Your study pile is still here",
        "We can still use `/review`, `/stats`, `/capture`, and `/pet` right now",
        setupLine
      ]);
    case "capture":
      return sentence([
        "I'm here, even before the live model is set up",
        "Start with one word through `/capture ...`, or open `/help` for a quick tour",
        setupLine
      ]);
  }
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
    revealPrompt: "Ready to peek?",
    gradePrompt: "How did that feel?",
    invalidReveal: {
      text: "Choose peek or pause so I know whether to show it.",
      kind: "review-session-status-warning"
    },
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
  if (error instanceof CardSelectionError) {
    return `I found more than one card for ${quote(error.selector)}. Pick a card id or name the card type.`;
  }

  if (error instanceof ConfigurationError) {
    if (/API key is missing/i.test(error.message)) {
      return "I need a live model connection before I can handle natural chat. Check `/models`, or set a key with `/model key ...` and try again.";
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

  if (error instanceof CardAuthorContractError) {
    return "I couldn't draft a clear review card from that yet, so I stopped before saving something confusing.";
  }

  if (
    error instanceof ProviderRequestError ||
    (error instanceof TypeError && /fetch failed/i.test(error.message))
  ) {
    if (error instanceof ProviderRequestError && /timed out/i.test(error.message)) {
      return "The model took too long to answer, so I stopped waiting. Try again, or check `/models` if that keeps happening.";
    }

    return "I couldn't reach the model just now. Try again, or check `/models` if the connection looks off.";
  }

  if (error instanceof Error && error.name === "SqliteError") {
    const code = (error as Error & { code?: string }).code ?? "";

    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return "Your study database is locked by another process. Close any other pawmemo sessions and try again, or use `pawmemo --db /tmp/test.db` to verify the issue.";
    }

    if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
      return "Your study database looks damaged. Try `pawmemo --db /tmp/test.db` to confirm, then check your backups.";
    }

    return "There's a problem with your study database. Try `pawmemo --db /tmp/test.db` to verify, or check that `pawmemo.db` isn't locked by another process.";
  }

  if (error instanceof Error) {
    return `Something slipped while I was handling that. ${trimSentence(error.message)}`;
  }

  return "Something slipped while I was handling that.";
}
