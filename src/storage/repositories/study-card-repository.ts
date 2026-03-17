import type {
  DueReviewCard,
  ListStudyCardsInput,
  ReviewCardDraft,
  ReviewCardState,
  ReviewCardType,
  StudyCardLifecycleState,
  StudyCardRecord
} from "../../core/domain/models";
import type { SqliteDatabase } from "../sqlite/database";

function asLifecycleState(value: unknown): StudyCardLifecycleState {
  return value === "paused" || value === "archived" ? value : "active";
}

function mapStudyCard(row: Record<string, unknown>): StudyCardRecord {
  return {
    id: Number(row.id),
    lexemeId: Number(row.lexeme_id),
    cardType: row.card_type as ReviewCardType,
    promptText: String(row.prompt_text),
    answerText: String(row.answer_text),
    state: row.state as ReviewCardState,
    lifecycleState: asLifecycleState(row.lifecycle_state),
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
    lifecycleState: asLifecycleState(row.lifecycle_state),
    dueAt: String(row.due_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class StudyCardRepository {
  constructor(private readonly db: SqliteDatabase) {}

  createMany(lexemeId: number, cards: ReviewCardDraft[], timestamp: string): StudyCardRecord[] {
    const insertCard = this.db.prepare(
      `
        INSERT INTO study_card (
          lexeme_id,
          card_type,
          prompt_text,
          answer_text,
          lifecycle_state,
          created_at,
          updated_at
        )
        VALUES (
          @lexemeId,
          @cardType,
          @promptText,
          @answerText,
          'active',
          @createdAt,
          @updatedAt
        )
      `
    );
    const insertLearningState = this.db.prepare(
      `
        INSERT INTO card_learning_state (
          study_card_id,
          state,
          due_at,
          created_at,
          updated_at
        )
        VALUES (?, 'new', ?, ?, ?)
      `
    );
    const selectCard = this.db.prepare(
      `
        SELECT
          sc.id,
          sc.lexeme_id,
          sc.card_type,
          sc.prompt_text,
          sc.answer_text,
          sc.lifecycle_state,
          sc.created_at,
          sc.updated_at,
          cls.state,
          cls.due_at
        FROM study_card sc
        JOIN card_learning_state cls ON cls.study_card_id = sc.id
        WHERE sc.id = ?
      `
    );

    const created: StudyCardRecord[] = [];

    for (const card of cards) {
      const result = insertCard.run({
        lexemeId,
        cardType: card.cardType,
        promptText: card.promptText,
        answerText: card.answerText,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const cardId = Number(result.lastInsertRowid);
      insertLearningState.run(cardId, timestamp, timestamp, timestamp);
      const row = selectCard.get(cardId) as Record<string, unknown>;
      created.push(mapStudyCard(row));
    }

    return created;
  }

  countDue(now: string, states: ReviewCardState[]): number {
    if (states.length === 0) {
      return 0;
    }

    const placeholders = states.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM study_card sc
          JOIN card_learning_state cls ON cls.study_card_id = sc.id
          WHERE cls.state IN (${placeholders}) AND cls.due_at <= ?
            AND sc.lifecycle_state = 'active'
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
            sc.id,
            sc.lexeme_id,
            l.lemma,
            sc.card_type,
            sc.prompt_text,
            sc.answer_text,
            sc.lifecycle_state,
            sc.created_at,
            sc.updated_at,
            cls.state,
            cls.due_at
          FROM study_card sc
          JOIN card_learning_state cls ON cls.study_card_id = sc.id
          JOIN lexemes l ON l.id = sc.lexeme_id
          WHERE cls.state IN (${placeholders})
            AND sc.lifecycle_state = 'active'
            AND cls.due_at <= ?
          ORDER BY cls.due_at ASC, sc.id ASC
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
            sc.id,
            sc.lexeme_id,
            l.lemma,
            sc.card_type,
            sc.prompt_text,
            sc.answer_text,
            sc.lifecycle_state,
            sc.created_at,
            sc.updated_at,
            cls.state,
            cls.due_at
          FROM study_card sc
          JOIN card_learning_state cls ON cls.study_card_id = sc.id
          JOIN lexemes l ON l.id = sc.lexeme_id
          WHERE sc.id = ?
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
        UPDATE card_learning_state
        SET
          state = @state,
          due_at = @dueAt,
          updated_at = @updatedAt
        WHERE study_card_id = @cardId
      `
    ).run({
      cardId,
      state: update.state,
      dueAt: update.dueAt,
      updatedAt: update.updatedAt
    });

    return this.getById(cardId) as DueReviewCard;
  }

  listWorkspace(input: ListStudyCardsInput = {}): DueReviewCard[] {
    const whereClauses: string[] = [];
    const params: Array<string | number> = [];

    if (input.word?.trim()) {
      whereClauses.push("l.normalized = ?");
      params.push(input.word.trim().toLowerCase());
    }

    if (input.cardType) {
      whereClauses.push("sc.card_type = ?");
      params.push(input.cardType);
    }

    if (input.lifecycleStates && input.lifecycleStates.length > 0) {
      const placeholders = input.lifecycleStates.map(() => "?").join(", ");
      whereClauses.push(`sc.lifecycle_state IN (${placeholders})`);
      params.push(...input.lifecycleStates);
    }

    const whereSql =
      whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const limit = input.limit ?? 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            sc.id,
            sc.lexeme_id,
            l.lemma,
            sc.card_type,
            sc.prompt_text,
            sc.answer_text,
            sc.lifecycle_state,
            sc.created_at,
            sc.updated_at,
            cls.state,
            cls.due_at
          FROM study_card sc
          JOIN card_learning_state cls ON cls.study_card_id = sc.id
          JOIN lexemes l ON l.id = sc.lexeme_id
          ${whereSql}
          ORDER BY l.lemma COLLATE NOCASE ASC, sc.id ASC
          LIMIT ?
        `
      )
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map(mapDueReviewCard);
  }

  updateContent(
    cardId: number,
    update: {
      promptText?: string;
      answerText?: string;
      updatedAt: string;
    }
  ): DueReviewCard {
    const current = this.getById(cardId);

    if (!current) {
      throw new Error(`Card ${cardId} not found.`);
    }

    this.db.prepare(
      `
        UPDATE study_card
        SET
          prompt_text = @promptText,
          answer_text = @answerText,
          updated_at = @updatedAt
        WHERE id = @cardId
      `
    ).run({
      cardId,
      promptText: update.promptText ?? current.promptText,
      answerText: update.answerText ?? current.answerText,
      updatedAt: update.updatedAt
    });

    return this.getById(cardId) as DueReviewCard;
  }

  updateLifecycle(
    cardId: number,
    lifecycleState: StudyCardLifecycleState,
    updatedAt: string
  ): DueReviewCard {
    this.db.prepare(
      `
        UPDATE study_card
        SET
          lifecycle_state = @lifecycleState,
          updated_at = @updatedAt
        WHERE id = @cardId
      `
    ).run({
      cardId,
      lifecycleState,
      updatedAt
    });

    return this.getById(cardId) as DueReviewCard;
  }

  delete(cardId: number): void {
    this.db.prepare(
      `
        DELETE FROM study_card
        WHERE id = ?
      `
    ).run(cardId);
  }
}
