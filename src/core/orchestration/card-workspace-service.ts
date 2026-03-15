import type {
  CreateStudyCardInput,
  DeleteStudyCardInput,
  DueReviewCard,
  ListStudyCardsInput,
  ListStudyCardsResult,
  SetStudyCardLifecycleInput,
  StudyCardOperationInput,
  StudyCardOperationResult,
  StudyCardSelector,
  UpdateStudyCardInput
} from "../domain/models";
import { nowIso } from "../../lib/time";
import {
  CardSelectionError,
  NotFoundError,
  UsageError
} from "../../lib/errors";
import { EventLogRepository } from "../../storage/repositories/event-log-repository";
import { LexemeRepository } from "../../storage/repositories/lexeme-repository";
import { ReviewCardRepository } from "../../storage/repositories/review-card-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function requireNonEmpty(name: string, value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`${name} must not be empty.`);
  }

  return value.trim();
}

function describeSelector(selector: StudyCardSelector): string {
  if (selector.cardId) {
    return `#${selector.cardId}`;
  }

  const word = selector.word?.trim() ?? "that card";
  return selector.cardType ? `${word} (${selector.cardType})` : word;
}

export class CardWorkspaceService {
  private readonly lexemes: LexemeRepository;
  private readonly reviewCards: ReviewCardRepository;
  private readonly eventLog: EventLogRepository;

  constructor(private readonly db: SqliteDatabase) {
    this.lexemes = new LexemeRepository(db);
    this.reviewCards = new ReviewCardRepository(db);
    this.eventLog = new EventLogRepository(db);
  }

  listCards(input: ListStudyCardsInput = {}): ListStudyCardsResult {
    return {
      cards: this.reviewCards.listWorkspace(input)
    };
  }

  execute(input: StudyCardOperationInput): StudyCardOperationResult {
    switch (input.kind) {
      case "list":
        return {
          kind: "list",
          cards: this.listCards(input.input).cards
        };
      case "create":
        return this.createCard(input.input);
      case "update":
        return this.updateCard(input.input);
      case "set-lifecycle":
        return this.setLifecycle(input.input);
      case "delete":
        return this.deleteCard(input.input);
    }
  }

  private createCard(input: CreateStudyCardInput): StudyCardOperationResult {
    const word = requireNonEmpty("word", input.word);
    const promptText = requireNonEmpty("prompt", input.promptText);
    const answerText = requireNonEmpty("answer", input.answerText);
    const normalized = normalizeWord(word);
    const lexeme = this.lexemes.findByNormalized(normalized);

    if (!lexeme) {
      throw new NotFoundError(
        `I only add extra cards for words already in the pile. Save "${word}" first with capture or teach.`
      );
    }

    const timestamp = nowIso();
    const card = this.db.transaction(() => {
      const created = this.reviewCards.createMany(
        lexeme.id,
        [
          {
            cardType: input.cardType,
            promptText,
            answerText
          }
        ],
        timestamp
      )[0];
      const resolved = this.reviewCards.getById(created.id);

      this.eventLog.append(
        "card.created",
        {
          cardId: created.id,
          lexemeId: lexeme.id,
          word: lexeme.lemma,
          cardType: created.cardType
        },
        timestamp
      );

      return resolved;
    })();

    return {
      kind: "create",
      card: card as DueReviewCard,
      previousLifecycleState: null
    };
  }

  private updateCard(input: UpdateStudyCardInput): StudyCardOperationResult {
    const nextPrompt =
      input.promptText === undefined ? undefined : requireNonEmpty("prompt", input.promptText);
    const nextAnswer =
      input.answerText === undefined ? undefined : requireNonEmpty("answer", input.answerText);

    if (nextPrompt === undefined && nextAnswer === undefined) {
      throw new UsageError("I need a new prompt, a new answer, or both.");
    }

    const current = this.resolveSelector(input.selector);
    const timestamp = nowIso();
    const card = this.db.transaction(() => {
      const updated = this.reviewCards.updateContent(current.id, {
        promptText: nextPrompt,
        answerText: nextAnswer,
        updatedAt: timestamp
      });

      this.eventLog.append(
        "card.updated",
        {
          cardId: current.id,
          lexemeId: current.lexemeId,
          word: current.lemma,
          fields: {
            promptText: nextPrompt !== undefined,
            answerText: nextAnswer !== undefined
          }
        },
        timestamp
      );

      return updated;
    })();

    return {
      kind: "update",
      card,
      previousLifecycleState: current.lifecycleState
    };
  }

  private setLifecycle(
    input: SetStudyCardLifecycleInput
  ): StudyCardOperationResult {
    const current = this.resolveSelector(input.selector);
    const timestamp = nowIso();
    const card = this.db.transaction(() => {
      const updated = this.reviewCards.updateLifecycle(
        current.id,
        input.lifecycleState,
        timestamp
      );

      this.eventLog.append(
        "card.lifecycle_changed",
        {
          cardId: current.id,
          lexemeId: current.lexemeId,
          word: current.lemma,
          previousLifecycleState: current.lifecycleState,
          lifecycleState: input.lifecycleState
        },
        timestamp
      );

      return updated;
    })();

    return {
      kind: "set-lifecycle",
      card,
      previousLifecycleState: current.lifecycleState
    };
  }

  private deleteCard(input: DeleteStudyCardInput): StudyCardOperationResult {
    const current = this.resolveSelector(input.selector);
    const timestamp = nowIso();

    this.db.transaction(() => {
      this.reviewCards.delete(current.id);
      this.eventLog.append(
        "card.deleted",
        {
          cardId: current.id,
          lexemeId: current.lexemeId,
          word: current.lemma,
          cardType: current.cardType
        },
        timestamp
      );
    })();

    return {
      kind: "delete",
      card: current
    };
  }

  private resolveSelector(selector: StudyCardSelector): DueReviewCard {
    if (selector.cardId !== undefined) {
      const card = this.reviewCards.getById(selector.cardId);

      if (!card) {
        throw new NotFoundError(`I couldn't find card #${selector.cardId}.`);
      }

      return card;
    }

    if (!selector.word?.trim()) {
      throw new UsageError("I need a card id or a word to know which card you mean.");
    }

    const matches = this.reviewCards.listWorkspace({
      word: selector.word,
      cardType: selector.cardType,
      lifecycleStates: ["active", "paused", "archived"],
      limit: 25
    });

    if (matches.length === 0) {
      throw new NotFoundError(
        `I couldn't find a card for ${describeSelector(selector)}.`
      );
    }

    if (matches.length > 1) {
      throw new CardSelectionError(
        `I found more than one card for ${describeSelector(selector)}.`,
        describeSelector(selector),
        matches
      );
    }

    return matches[0];
  }
}
