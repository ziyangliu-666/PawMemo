import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type {
  DueReviewCard,
  GradeReviewCardResult,
  ReviewGrade,
  ReviewRevealResult
} from "../core/domain/models";
import { StudyServices } from "../core/orchestration/study-services";
import type { SqliteDatabase } from "../storage/sqlite/database";
import type { StudyCellIntent } from "./transcript-intent";
import {
  appendStudyCardSections,
  createReviewCardBodySections,
  createReviewMetadataSection,
  createReviewResultSection,
  createReviewIntroIntent,
  createReviewSummaryIntent
} from "./study-card-view";
import { createCliTheme, shouldUseColor } from "./theme";
import type { CliDataKind } from "./theme";

const GRADE_ALIASES: Record<string, ReviewGrade> = {
  a: "again",
  again: "again",
  h: "hard",
  hard: "hard",
  g: "good",
  good: "good",
  e: "easy",
  easy: "easy"
};

export interface ReviewSessionServices {
  getNext(now?: string): DueReviewCard | null;
  reveal(cardId: number): ReviewRevealResult;
  grade(cardId: number, grade: ReviewGrade, reviewedAt?: string): GradeReviewCardResult;
}

export interface ReviewSessionTerminal {
  readonly supportsColor?: boolean;
  write(text: string): void;
  writeDataBlock?(
    text: string,
    kind: CliDataKind,
    intent?: StudyCellIntent
  ): void;
  select?(request: PromptSelectionRequest): Promise<string>;
  prompt(promptText: string): Promise<string>;
  setMode?(mode: string): void;
  close(): Promise<void> | void;
}

export interface ReviewSessionRunOptions {
  limit?: number;
  now?: string;
}

export interface ReviewSessionRunResult {
  reviewedCount: number;
  quitEarly: boolean;
  limitReached: boolean;
  gradeCounts: Record<ReviewGrade, number>;
}

export interface PromptSelectionChoice {
  value: string;
  label: string;
  aliases?: string[];
  description?: string;
}

export interface PromptSelectionRequest {
  promptText: string;
  choices: PromptSelectionChoice[];
  initialValue?: string;
}

export interface ReviewSessionCopy {
  sessionHeading(limit?: number): Array<{ text: string; kind: CliDataKind }>;
  noDueCards(reviewedCount: number): { text: string; kind: CliDataKind };
  sessionPaused(reviewedCount: number): { text: string; kind: CliDataKind };
  sessionEndedEarly(reviewedCount: number): { text: string; kind: CliDataKind };
  cardHeading(card: DueReviewCard, index: number): string;
  showCardMetadata: boolean;
  revealPrompt: string;
  gradePrompt: string;
  invalidReveal: { text: string; kind: CliDataKind };
  invalidGrade: { text: string; kind: CliDataKind };
  answerLine(answerText: string): string;
  savedGradeResult(result: GradeReviewCardResult): { text: string; kind: CliDataKind };
}

function createDefaultReviewSessionCopy(): ReviewSessionCopy {
  return {
    sessionHeading(limit?: number) {
      const lines: Array<{ text: string; kind: CliDataKind }> = [
        {
          text: "PawMemo review session",
          kind: "review-session-heading"
        }
      ];

      if (typeof limit === "number") {
        lines.push({
          text: `Session limit: ${limit}`,
          kind: "review-card-field"
        });
      }

      return lines;
    },
    noDueCards(reviewedCount) {
      return {
        text:
          reviewedCount === 0
            ? "No due cards."
            : `Session complete. Reviewed ${reviewedCount} card(s).`,
        kind:
          reviewedCount === 0
            ? "review-session-status-warning"
            : "review-session-status-success"
      };
    },
    sessionPaused(reviewedCount) {
      return {
        text: `Session paused after ${reviewedCount} card(s).`,
        kind: "review-session-status-warning"
      };
    },
    sessionEndedEarly(reviewedCount) {
      return {
        text: `Session ended early. Reviewed ${reviewedCount} card(s).`,
        kind: "review-session-status-warning"
      };
    },
    cardHeading(card, index) {
      return `Card ${index}: #${card.id} (${card.lemma})`;
    },
    showCardMetadata: true,
    revealPrompt: "Ready to reveal the answer?",
    gradePrompt: "How did that feel?",
    invalidReveal: {
      text: "Choose reveal or quit so I know whether to show the answer.",
      kind: "review-session-status-warning"
    },
    invalidGrade: {
      text: "Please enter again, hard, good, easy, or q.",
      kind: "review-session-status-warning"
    },
    answerLine(answerText) {
      return `Answer: ${answerText}`;
    },
    savedGradeResult(result) {
      return {
        text: `Saved ${result.grade}. Next due: ${result.card.dueAt}. Mastery: ${result.mastery.state}.`,
        kind: "review-session-status-success"
      };
    }
  };
}

export function createStudyReviewSessionServices(
  study: Pick<
    StudyServices,
    "getNextReviewCard" | "revealReviewCard" | "gradeReviewCard"
  >
): ReviewSessionServices {
  return {
    getNext: (now?: string) => study.getNextReviewCard(now),
    reveal: (cardId: number) => study.revealReviewCard(cardId),
    grade: (cardId: number, grade: ReviewGrade, reviewedAt?: string) =>
      study.gradeReviewCard({
        cardId,
        grade,
        reviewedAt
      })
  };
}

export class ReadlineReviewSessionTerminal implements ReviewSessionTerminal {
  readonly supportsColor = shouldUseColor(output);

  private readonly readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY)
  });

  write(text: string): void {
    output.write(`${text}\n`);
  }

  prompt(promptText: string): Promise<string> {
    return this.readline.question(promptText);
  }

  close(): void {
    this.readline.close();
  }
}

export function createDefaultReviewSessionTerminal(): ReviewSessionTerminal {
  return new ReadlineReviewSessionTerminal();
}

function formatSelectionChoice(
  choice: PromptSelectionChoice,
  request: PromptSelectionRequest
): string {
  const alias = choice.aliases?.[0];
  const prefix = alias ? `[${alias}] ` : "";
  const suffix = request.initialValue === choice.value ? " (Enter)" : "";
  const description = choice.description ? ` - ${choice.description}` : "";
  return `${prefix}${choice.label}${suffix}${description}`;
}

export function formatPromptSelectionPrompt(
  request: PromptSelectionRequest
): string {
  const choices = request.choices
    .map((choice) => formatSelectionChoice(choice, request))
    .join("  ");

  return `${request.promptText} ${choices}: `;
}

export function resolvePromptSelection(
  request: PromptSelectionRequest,
  rawInput: string
): string | null {
  const normalized = rawInput.trim().toLowerCase();

  if (normalized.length === 0) {
    return request.initialValue ?? null;
  }

  const matched = request.choices.find((choice) => {
    if (choice.value.toLowerCase() === normalized) {
      return true;
    }

    return choice.aliases?.some((alias) => alias.toLowerCase() === normalized) ?? false;
  });

  return matched?.value ?? null;
}

function normalizeGrade(value: string): ReviewGrade | null {
  return GRADE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export class ReviewSessionRunner {
  private readonly theme: ReturnType<typeof createCliTheme>;
  private readonly copy: ReviewSessionCopy;
  private readonly revealSelection: PromptSelectionRequest;
  private readonly gradeSelection: PromptSelectionRequest;

  constructor(
    private readonly services: ReviewSessionServices,
    private readonly terminal: ReviewSessionTerminal,
    copy: ReviewSessionCopy = createDefaultReviewSessionCopy()
  ) {
    this.theme = createCliTheme({
      enabled: this.terminal.supportsColor ?? false
    });
    this.copy = copy;
    this.revealSelection = {
      promptText: this.copy.revealPrompt,
      initialValue: "reveal",
      choices: [
        {
          value: "reveal",
          label: "Peek answer",
          aliases: ["p", "peek", "reveal"]
        },
        {
          value: "quit",
          label: "Pause",
          aliases: ["q", "quit", "pause"]
        }
      ]
    };
    this.gradeSelection = {
      promptText: this.copy.gradePrompt,
      initialValue: "good",
      choices: [
        {
          value: "again",
          label: "Again",
          aliases: ["a", "again"]
        },
        {
          value: "hard",
          label: "Hard",
          aliases: ["h", "hard"]
        },
        {
          value: "good",
          label: "Good",
          aliases: ["g", "good"]
        },
        {
          value: "easy",
          label: "Easy",
          aliases: ["e", "easy"]
        },
        {
          value: "quit",
          label: "Pause",
          aliases: ["q", "quit", "pause"]
        }
      ]
    };
  }

  static fromDatabase(
    db: SqliteDatabase,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    const study = new StudyServices(db);
    return new ReviewSessionRunner(
      createStudyReviewSessionServices(study),
      new ReadlineReviewSessionTerminal(),
      copy
    );
  }

  static withTerminal(
    db: SqliteDatabase,
    terminal: ReviewSessionTerminal,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    const study = new StudyServices(db);
    return new ReviewSessionRunner(
      createStudyReviewSessionServices(study),
      terminal,
      copy
    );
  }

  static withServices(
    services: ReviewSessionServices,
    terminal: ReviewSessionTerminal,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    return new ReviewSessionRunner(services, terminal, copy);
  }

  static withDefaultTerminal(
    services: ReviewSessionServices,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    return new ReviewSessionRunner(
      services,
      new ReadlineReviewSessionTerminal(),
      copy
    );
  }

  async run(options: ReviewSessionRunOptions = {}): Promise<ReviewSessionRunResult> {
    let reviewedCount = 0;
    const gradeCounts: Record<ReviewGrade, number> = {
      again: 0,
      hard: 0,
      good: 0,
      easy: 0
    };

    const introLines = this.copy.sessionHeading(options.limit);
    if (introLines.length > 0) {
      this.writeDataBlock(
        introLines.map((line) => line.text).join("\n"),
        introLines[0]?.kind ?? "review-session-heading",
        createReviewIntroIntent(introLines.map((line) => line.text))
      );
    }

    try {
      while (true) {
        if (
          typeof options.limit === "number" &&
          reviewedCount >= options.limit
        ) {
          this.terminal.setMode?.("Summary");
          const paused = this.copy.sessionPaused(reviewedCount);
          this.writeDataBlock(
            paused.text,
            paused.kind,
            createReviewSummaryIntent(paused.text, "Paused here")
          );

          return {
            reviewedCount,
            quitEarly: false,
            limitReached: true,
            gradeCounts
          };
        }

        const nextCard = this.services.getNext(options.now);

        if (!nextCard) {
          this.terminal.setMode?.("Summary");
          const done = this.copy.noDueCards(reviewedCount);
          this.writeDataBlock(
            done.text,
            done.kind,
            createReviewSummaryIntent(
              done.text,
              reviewedCount === 0 ? "All clear" : "Lap complete"
            )
          );

          return {
            reviewedCount,
            quitEarly: false,
            limitReached: false,
            gradeCounts
          };
        }

        this.terminal.setMode?.("Review");
        const cardIntent = this.createReviewCardIntent(nextCard.id, reviewedCount + 1);
        this.printCard(nextCard, reviewedCount + 1, cardIntent);

        while (true) {
          const revealAction = await this.readSelection(this.revealSelection);

          if (revealAction === null) {
            this.writeDataBlock(
              this.copy.invalidReveal.text,
              this.copy.invalidReveal.kind,
              createReviewSummaryIntent(this.copy.invalidReveal.text, "Need a choice")
            );
            continue;
          }

          if (revealAction === "quit") {
            this.terminal.setMode?.("Summary");
            const endedEarly = this.copy.sessionEndedEarly(reviewedCount);
            this.writeDataBlock(
              endedEarly.text,
              endedEarly.kind,
              createReviewSummaryIntent(endedEarly.text, "Paused here")
            );

            return {
              reviewedCount,
              quitEarly: true,
              limitReached: false,
              gradeCounts
            };
          }

          break;
        }

        this.terminal.setMode?.("Reveal");
        const reveal = this.services.reveal(nextCard.id);
        this.printReveal(reveal, cardIntent);

        while (true) {
          const selection = await this.readSelection(this.gradeSelection);

          if (selection === "quit") {
            this.terminal.setMode?.("Summary");
            const endedEarly = this.copy.sessionEndedEarly(reviewedCount);
            this.writeDataBlock(
              endedEarly.text,
              endedEarly.kind,
              createReviewSummaryIntent(endedEarly.text, "Paused here")
            );

            return {
              reviewedCount,
              quitEarly: true,
              limitReached: false,
              gradeCounts
            };
          }

          const grade = selection ? normalizeGrade(selection) : null;

          if (!grade) {
            this.writeDataBlock(
              this.copy.invalidGrade.text,
              this.copy.invalidGrade.kind,
              createReviewSummaryIntent(this.copy.invalidGrade.text, "Need a grade")
            );
            continue;
          }

          const result = this.services.grade(nextCard.id, grade, options.now);
          reviewedCount += 1;
          gradeCounts[grade] += 1;
          this.printGradeResult(result);
          break;
        }
      }
    } finally {
      await this.terminal.close();
    }
  }

  private async readSelection(
    request: PromptSelectionRequest
  ): Promise<string | null> {
    if (this.terminal.select) {
      const selected = await this.terminal.select(request);
      return resolvePromptSelection(request, selected);
    }

    const rawInput = await this.terminal.prompt(
      this.theme.prompt(formatPromptSelectionPrompt(request))
    );
    return resolvePromptSelection(request, rawInput);
  }

  private printCard(
    card: DueReviewCard,
    index: number,
    studyIntent: StudyCellIntent
  ): void {
    this.terminal.write("");
    const heading = this.copy.cardHeading(card, index);
    const cardSections = createReviewCardBodySections(
      heading,
      card.lemma,
      card.cardType,
      card.promptText
    );
    this.writeDataBlock(
      heading,
      "review-card-heading",
      appendStudyCardSections(
        {
          kind: "review-card",
          title: "card",
          emphasis: studyIntent.emphasis,
          groupId: studyIntent.groupId
        },
        cardSections.slice(0, 2)
      )
    );

    if (this.copy.showCardMetadata) {
      this.writeDataBlock(`Type: ${card.cardType}`, "review-card-field", appendStudyCardSections(
        {
          kind: "review-card",
          title: "card",
          emphasis: studyIntent.emphasis,
          groupId: studyIntent.groupId
        },
        [createReviewMetadataSection(`Type: ${card.cardType}`)]
      ));
      this.writeDataBlock(`State: ${card.state}`, "review-card-field", appendStudyCardSections(
        {
          kind: "review-card",
          title: "card",
          emphasis: studyIntent.emphasis,
          groupId: studyIntent.groupId
        },
        [createReviewMetadataSection(`State: ${card.state}`)]
      ));
    }

    this.writeDataBlock(
      card.promptText,
      "plain",
      appendStudyCardSections(
        {
          kind: "review-card",
          title: "card",
          emphasis: studyIntent.emphasis,
          groupId: studyIntent.groupId
        },
        cardSections.slice(2)
      )
    );
  }

  private printReveal(
    result: ReviewRevealResult,
    studyIntent: StudyCellIntent
  ): void {
    this.writeDataBlock(
      this.copy.answerLine(result.card.answerText),
      "review-card-field",
      appendStudyCardSections(
        {
          kind: "review-card",
          title: "card",
          emphasis: studyIntent.emphasis,
          groupId: studyIntent.groupId
        },
        [
          {
            role: "eyebrow",
            text: "Answer"
          },
          {
            role: "answer",
            text: this.copy.answerLine(result.card.answerText)
          }
        ]
      )
    );
  }

  private printGradeResult(result: GradeReviewCardResult): void {
    const saved = this.copy.savedGradeResult(result);
    this.writeDataBlock(
      saved.text,
      saved.kind,
      appendStudyCardSections(
        {
          kind: "review-summary",
          title: "summary",
          groupId: "review-session-summary"
        },
        [
          { role: "title", text: "Saved" },
          createReviewResultSection(saved.text)
        ]
      )
    );
  }

  private createReviewCardIntent(cardId: number, index: number): StudyCellIntent {
    return appendStudyCardSections(
      {
        kind: "review-card",
        title: "card",
        emphasis: "What we were looking for:",
        groupId: `review-card-${cardId}-${index}`
      },
      []
    );
  }

  private writeDataBlock(
    text: string,
    kind: CliDataKind,
    intent?: StudyCellIntent
  ): void {
    if (this.terminal.writeDataBlock) {
      this.terminal.writeDataBlock(text, kind, intent);
      return;
    }

    this.terminal.write(this.theme.dataBlock(text, kind));
  }
}
