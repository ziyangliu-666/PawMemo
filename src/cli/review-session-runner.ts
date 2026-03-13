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

export interface ReviewSessionCopy {
  sessionHeading(limit?: number): Array<{ text: string; kind: CliDataKind }>;
  noDueCards(reviewedCount: number): { text: string; kind: CliDataKind };
  sessionPaused(reviewedCount: number): { text: string; kind: CliDataKind };
  sessionEndedEarly(reviewedCount: number): { text: string; kind: CliDataKind };
  cardHeading(card: DueReviewCard, index: number): string;
  showCardMetadata: boolean;
  revealPrompt: string;
  gradePrompt: string;
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
    revealPrompt: "Press Enter to reveal, or type q to quit: ",
    gradePrompt: "Grade [a]gain [h]ard [g]ood [e]asy, or q to quit: ",
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

class ServiceBackedReviewSessionServices implements ReviewSessionServices {
  private readonly study: StudyServices;

  constructor(db: SqliteDatabase) {
    this.study = new StudyServices(db);
  }

  getNext(now?: string): DueReviewCard | null {
    return this.study.getNextReviewCard(now);
  }

  reveal(cardId: number): ReviewRevealResult {
    return this.study.revealReviewCard(cardId);
  }

  grade(cardId: number, grade: ReviewGrade, reviewedAt?: string): GradeReviewCardResult {
    return this.study.gradeReviewCard({
      cardId,
      grade,
      reviewedAt
    });
  }
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

function normalizeGrade(value: string): ReviewGrade | null {
  return GRADE_ALIASES[value.trim().toLowerCase()] ?? null;
}

export class ReviewSessionRunner {
  private readonly theme: ReturnType<typeof createCliTheme>;
  private readonly copy: ReviewSessionCopy;

  constructor(
    private readonly services: ReviewSessionServices,
    private readonly terminal: ReviewSessionTerminal,
    copy: ReviewSessionCopy = createDefaultReviewSessionCopy()
  ) {
    this.theme = createCliTheme({
      enabled: this.terminal.supportsColor ?? false
    });
    this.copy = copy;
  }

  static fromDatabase(
    db: SqliteDatabase,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    return new ReviewSessionRunner(
      new ServiceBackedReviewSessionServices(db),
      new ReadlineReviewSessionTerminal(),
      copy
    );
  }

  static withTerminal(
    db: SqliteDatabase,
    terminal: ReviewSessionTerminal,
    copy?: ReviewSessionCopy
  ): ReviewSessionRunner {
    return new ReviewSessionRunner(
      new ServiceBackedReviewSessionServices(db),
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

    const introIntent: StudyCellIntent = {
      kind: "review-intro",
      title: "review",
      groupId: "review-session-intro"
    };

    for (const line of this.copy.sessionHeading(options.limit)) {
      this.writeDataBlock(line.text, line.kind, introIntent);
    }

    try {
      while (true) {
        if (
          typeof options.limit === "number" &&
          reviewedCount >= options.limit
        ) {
          this.terminal.setMode?.("Summary");
          const paused = this.copy.sessionPaused(reviewedCount);
          this.writeDataBlock(paused.text, paused.kind, {
            kind: "review-summary",
            title: "summary",
            groupId: "review-session-summary"
          });

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
          this.writeDataBlock(done.text, done.kind, {
            kind: "review-summary",
            title: "summary",
            groupId: "review-session-summary"
          });

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

        const revealAction = (await this.terminal.prompt(
          this.theme.prompt(this.copy.revealPrompt)
        ))
          .trim()
          .toLowerCase();

        if (revealAction === "q" || revealAction === "quit") {
          this.terminal.setMode?.("Summary");
          const endedEarly = this.copy.sessionEndedEarly(reviewedCount);
          this.writeDataBlock(endedEarly.text, endedEarly.kind, {
            kind: "review-summary",
            title: "summary"
          });

          return {
            reviewedCount,
            quitEarly: true,
            limitReached: false,
            gradeCounts
          };
        }

        this.terminal.setMode?.("Reveal");
        const reveal = this.services.reveal(nextCard.id);
        this.printReveal(reveal, cardIntent);

        while (true) {
          const gradeInput = await this.terminal.prompt(
            this.theme.prompt(this.copy.gradePrompt)
          );
          const normalized = gradeInput.trim().toLowerCase();

          if (normalized === "q" || normalized === "quit") {
            this.terminal.setMode?.("Summary");
            const endedEarly = this.copy.sessionEndedEarly(reviewedCount);
            this.writeDataBlock(endedEarly.text, endedEarly.kind, {
              kind: "review-summary",
              title: "summary",
              groupId: "review-session-summary"
            });

            return {
              reviewedCount,
              quitEarly: true,
              limitReached: false,
              gradeCounts
            };
          }

          const grade = normalizeGrade(normalized);

          if (!grade) {
            this.writeDataBlock(
              this.copy.invalidGrade.text,
              this.copy.invalidGrade.kind,
              {
                kind: "review-summary",
                title: "summary",
                groupId: "review-session-summary"
              }
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

  private printCard(
    card: DueReviewCard,
    index: number,
    studyIntent: StudyCellIntent
  ): void {
    this.terminal.write("");

    this.writeDataBlock(
      this.copy.cardHeading(card, index),
      "review-card-heading",
      studyIntent
    );

    if (this.copy.showCardMetadata) {
      this.writeDataBlock(`Type: ${card.cardType}`, "review-card-field", studyIntent);
      this.writeDataBlock(`State: ${card.state}`, "review-card-field", studyIntent);
    }

    this.writeDataBlock(card.promptText, "plain", studyIntent);
  }

  private printReveal(
    result: ReviewRevealResult,
    studyIntent: StudyCellIntent
  ): void {
    this.writeDataBlock(
      this.copy.answerLine(result.card.answerText),
      "review-card-field",
      studyIntent
    );
  }

  private printGradeResult(result: GradeReviewCardResult): void {
    const saved = this.copy.savedGradeResult(result);
    this.writeDataBlock(saved.text, saved.kind, {
      kind: "review-summary",
      title: "summary",
      groupId: "review-session-summary"
    });
  }

  private createReviewCardIntent(cardId: number, index: number): StudyCellIntent {
    return {
      kind: "review-card",
      title: "card",
      emphasis: "What we were looking for:",
      groupId: `review-card-${cardId}-${index}`
    };
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
