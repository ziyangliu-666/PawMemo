import type {
  DueReviewCard,
  ReviewCardDraft,
  ReviewCardRecord,
  ReviewCardState,
  ReviewCardType
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function mapReviewCard(row: Record<string, unknown>): ReviewCardRecord {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    cardType: row.card_type as ReviewCardType,
    promptText: String(row.prompt_text),
    answerText: String(row.answer_text),
    state: row.state as ReviewCardState,
    dueAt: String(row.due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapDueReviewCard(row: Record<string, unknown>): DueReviewCard {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    lemma: String(row.lemma),
    cardType: row.card_type as ReviewCardType,
    promptText: String(row.prompt_text),
    answerText: String(row.answer_text),
    state: row.state as ReviewCardState,
    dueAt: String(row.due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class ReviewCardRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createMany(lexemeId: number, cards: ReviewCardDraft[], timestamp: string): ReviewCardRecord[] {
    const insert = this.db.prepare(
      `
        INSERT INTO review_cards (
          lexeme_id,
          card_type,
          prompt_text,
          answer_text,
          state,
          due_at,
          created_at,
          updated_at
        )
        VALUES (
          @lexemeId,
          @cardType,
          @promptText,
          @answerText,
          'new',
          @dueAt,
          @createdAt,
          @updatedAt
        )
      `
    );
    const select = this.db.prepare(
      `
        SELECT
          id,
          lexeme_id,
          card_type,
          prompt_text,
          answer_text,
          state,
          due_at,
          created_at,
          updated_at
        FROM review_cards
        WHERE id = ?
      `
    );

    const created: ReviewCardRecord[] = [];

    for (const card of cards) {
      const result = insert.run({
        lexemeId,
        cardType: card.cardType,
        promptText: card.promptText,
        answerText: card.answerText,
        dueAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      const row = select.get(result.lastInsertRowid) as Record<string, unknown>;
      created.push(mapReviewCard(row));
    }

    return created;
  }

  countDue(now: string, states: ReviewCardState[]): number {
    const placeholders = states.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM review_cards
          WHERE state IN (${placeholders}) AND due_at <= ?
        `
      )
      .get(...states, now) as Record<string, unknown>;

    return Number(row.count);
  }

  listDue(now: string, states: ReviewCardState[], limit: number): DueReviewCard[] {
    if (limit <= 0) {
      return [];
    }

    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          SELECT
            review_cards.id,
            review_cards.lexeme_id,
            lexemes.lemma,
            review_cards.card_type,
            review_cards.prompt_text,
            review_cards.answer_text,
            review_cards.state,
            review_cards.due_at,
            review_cards.created_at,
            review_cards.updated_at
          FROM review_cards
          INNER JOIN lexemes ON lexemes.id = review_cards.lexeme_id
          WHERE review_cards.state IN (${placeholders}) AND review_cards.due_at <= ?
          ORDER BY review_cards.due_at ASC, review_cards.id ASC
          LIMIT ?
        `
      )
      .all(...states, now, limit) as Record<string, unknown>[];

    return rows.map(mapDueReviewCard);
  }

  getById(cardId: number): DueReviewCard | null {
    const row = this.db
      .prepare(
        `
          SELECT
            review_cards.id,
            review_cards.lexeme_id,
            lexemes.lemma,
            review_cards.card_type,
            review_cards.prompt_text,
            review_cards.answer_text,
            review_cards.state,
            review_cards.due_at,
            review_cards.created_at,
            review_cards.updated_at
          FROM review_cards
          INNER JOIN lexemes ON lexemes.id = review_cards.lexeme_id
          WHERE review_cards.id = ?
        `
      )
      .get(cardId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return mapDueReviewCard(row);
  }

  applyReview(
    cardId: number,
    update: {
      state: ReviewCardState;
      dueAt: string;
      updatedAt: string;
    }
  ): DueReviewCard {
    this.db.prepare(
      `
        UPDATE review_cards
        SET
          state = @state,
          due_at = @dueAt,
          updated_at = @updatedAt
        WHERE id = @cardId
      `
    ).run({
      cardId,
      state: update.state,
      dueAt: update.dueAt,
      updatedAt: update.updatedAt
    });

    return this.getById(cardId) as DueReviewCard;
  }
}
