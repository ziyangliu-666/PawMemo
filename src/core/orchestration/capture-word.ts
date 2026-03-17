import type { CaptureWordInput, CaptureWordResult } from "../domain/models";
import { buildCardSeeds } from "../../review/card-builder";
import { detectCardPromptLanguage } from "../../review/card-language";
import { nowIso } from "../../lib/time";
import { EncounterRepository } from "../../storage/repositories/encounter-repository";
import { EventLogRepository } from "../../storage/repositories/event-log-repository";
import { LexemeRepository } from "../../storage/repositories/lexeme-repository";
import { StudyEntryRepository } from "../../storage/repositories/study-entry-repository";
import { StudyCardRepository } from "../../storage/repositories/study-card-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function requireValue(name: string, value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${name} must not be empty.`);
  }

  return trimmed;
}

export class CaptureWordService {
  private readonly lexemes: LexemeRepository;
  private readonly encounters: EncounterRepository;
  private readonly studyEntry: StudyEntryRepository;
  private readonly studyCards: StudyCardRepository;
  private readonly eventLog: EventLogRepository;

  constructor(private readonly db: SqliteDatabase) {
    this.lexemes = new LexemeRepository(db);
    this.encounters = new EncounterRepository(db);
    this.studyEntry = new StudyEntryRepository(db);
    this.studyCards = new StudyCardRepository(db);
    this.eventLog = new EventLogRepository(db);
  }

  capture(input: CaptureWordInput): CaptureWordResult {
    const word = requireValue("word", input.word);
    const rawContext = requireValue("context", input.context);
    const gloss = requireValue("gloss", input.gloss);
    const context = input.cardDraft
      ? requireValue("cardDraft.normalizedContext", input.cardDraft.normalizedContext)
      : rawContext;
    const promptLanguage = input.promptLanguage ?? detectCardPromptLanguage(rawContext);
    const capturedAt = nowIso(input.capturedAt);
    const normalized = normalizeWord(word);
    const seeds = buildCardSeeds({
      word,
      context,
      gloss,
      promptLanguage,
      clozeContext: input.cardDraft?.clozeContext ?? null,
      cardTypes: input.cardDraft?.cardTypes
    });

    return this.db.transaction(() => {
      const lexeme = this.lexemes.upsert(word, normalized, capturedAt);
      const sense = this.lexemes.upsertSense(lexeme.id, gloss, context, capturedAt);
      const encounter = this.encounters.create(
        lexeme.id,
        context,
        input.sourceLabel,
        capturedAt
      );
      const mastery = this.studyEntry.ensureSeen(lexeme.id, capturedAt);
      const cards = this.studyCards.createMany(lexeme.id, seeds, capturedAt);

      this.eventLog.append(
        "word.captured",
        {
          lexemeId: lexeme.id,
          word: lexeme.lemma,
          sourceLabel: input.sourceLabel ?? null,
          cardTypes: cards.map((card) => card.cardType)
        },
        capturedAt
      );

      return {
        lexeme,
        sense,
        encounter,
        mastery,
        cards
      };
    })();
  }
}
