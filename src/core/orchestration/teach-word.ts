import { performance } from "node:perf_hooks";
import type {
  CaptureWordInput,
  ReviewCardType,
  TeachCardDraft,
  TeachWordDraftOutcome,
  TeachWordDraftResult,
  TeachWordInput,
  TeachWordResult,
  LlmProviderName
} from "../domain/models";
import { CaptureWordService } from "./capture-word";
import { EventLogRepository } from "../../storage/repositories/event-log-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import { createLlmProvider } from "../../llm/provider-factory";
import type { LlmProvider } from "../../llm/types";
import { ExplanationEngine } from "../explanation/explanation-engine";
import { toAskWordResult } from "../explanation/types";
import { CardAuthorEngine } from "../card-author/card-author-engine";
import { CardAuthorContractError, ExplanationContractError } from "../../lib/errors";
import { detectCardPromptLanguage } from "../../review/card-language";
import { buildCardSeeds } from "../../review/card-builder";

export interface TeachPerfEvent {
  stage: "explanation_llm" | "card_author_llm" | "sqlite_capture";
  elapsedMs: number;
}

export type TeachPerfHook = (event: TeachPerfEvent) => void;

function stripTrailingSentencePunctuation(value: string): string {
  return value.trim().replace(/[.?!,;:。！？；：、]+$/u, "").trim();
}

function capitalizeLeadingAscii(value: string): string {
  if (!/^[a-z]/.test(value)) {
    return value;
  }

  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function buildDefinitionCardContext(
  word: string,
  gloss: string,
  promptLanguage: "en" | "zh"
): { normalizedContext: string; clozeContext: string } {
  const normalizedWord = word.trim();
  const normalizedGloss = stripTrailingSentencePunctuation(gloss);

  if (promptLanguage === "zh") {
    return {
      normalizedContext: `${normalizedWord} 的意思是 ${normalizedGloss}。`,
      clozeContext: `____ 的意思是 ${normalizedGloss}。`
    };
  }

  return {
    normalizedContext: `${capitalizeLeadingAscii(normalizedWord)} means ${normalizedGloss}.`,
    clozeContext: `____ means ${normalizedGloss}.`
  };
}

export class TeachWordService {
  private readonly explanationEngine: ExplanationEngine;
  private readonly cardAuthorEngine: CardAuthorEngine;
  private readonly captureService: CaptureWordService;
  private readonly eventLog: EventLogRepository;

  constructor(
    db: SqliteDatabase,
    providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.explanationEngine = new ExplanationEngine(db, providerFactory);
    this.cardAuthorEngine = new CardAuthorEngine(db, providerFactory);
    this.captureService = new CaptureWordService(db);
    this.eventLog = new EventLogRepository(db);
  }

  async teach(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordResult> {
    const draft = await this.draft(input, perfHook, options);

    if (draft.status !== "ready") {
      throw new CardAuthorContractError(
        `Provider did not return a usable study context for \`teach\`. ${draft.reason}`
      );
    }

    return this.confirmDraft(input, draft, perfHook);
  }

  async draft(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordDraftOutcome> {
    const explanationStartedAt = performance.now();
    const explanation = await this.explanationEngine.explain(input, options);
    perfHook?.({
      stage: "explanation_llm",
      elapsedMs: performance.now() - explanationStartedAt
    });

    if (!explanation.providerGlossAccepted) {
      throw new ExplanationContractError(
        "Provider did not return a usable gloss for `teach`."
      );
    }

    const ask = toAskWordResult(explanation);
    const promptLanguage = detectCardPromptLanguage(input.context);
    const authoredCards: {
      accepted: boolean;
      normalizedContext: string | null;
      clozeContext: string | null;
      reason: string | null;
    } = input.studyContextMode === "definition"
      ? {
          accepted: true,
          ...buildDefinitionCardContext(input.word, explanation.gloss, promptLanguage),
          reason: null
        }
      : await (async () => {
      const cardAuthorStartedAt = performance.now();
      const result = await this.cardAuthorEngine.author({
        word: input.word,
        context: input.context,
        gloss: explanation.gloss,
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
        apiUrl: input.apiUrl
      }, options);
      perfHook?.({
        stage: "card_author_llm",
        elapsedMs: performance.now() - cardAuthorStartedAt
      });
      return result;
    })();

    if (!authoredCards.accepted || !authoredCards.normalizedContext) {
      return {
        status: "needs_clarification",
        ask,
        promptLanguage,
        reason:
          authoredCards.reason ??
          "The study context needs clarification before PawMemo can save it."
      };
    }

    const cardTypes: ReviewCardType[] | undefined =
      input.studyContextMode === "definition" ? ["cloze"] : undefined;

    const draft: TeachCardDraft = {
      word: input.word,
      gloss: explanation.gloss,
      promptLanguage,
      normalizedContext: authoredCards.normalizedContext,
      clozeContext: authoredCards.clozeContext,
      cards: buildCardSeeds({
        word: input.word,
        context: authoredCards.normalizedContext,
        gloss: explanation.gloss,
        promptLanguage,
        clozeContext: authoredCards.clozeContext,
        cardTypes
      })
    };

    return {
      status: "ready",
      ask,
      draft
    };
  }

  confirmDraft(
    input: TeachWordInput,
    draftResult: TeachWordDraftResult,
    perfHook?: TeachPerfHook
  ): TeachWordResult {
    const { ask, draft } = draftResult;
    const captureStartedAt = performance.now();
    const captureInput: CaptureWordInput = {
      word: input.word,
      context: input.context,
      gloss: draft.gloss,
      promptLanguage: draft.promptLanguage,
      cardDraft: {
        normalizedContext: draft.normalizedContext,
        clozeContext: draft.clozeContext,
        cardTypes: draft.cards.map((card) => card.cardType)
      },
      sourceLabel: input.sourceLabel ?? "llm-teach"
    };
    const capture = this.captureService.capture(captureInput);
    perfHook?.({
      stage: "sqlite_capture",
      elapsedMs: performance.now() - captureStartedAt
    });

    this.eventLog.append(
      "word.taught",
      {
        word: ask.word,
        normalized: ask.normalized,
        provider: ask.provider,
        model: ask.model,
        gloss: draft.gloss,
        lexemeId: capture.lexeme.id
      },
      capture.encounter.capturedAt
    );

    return {
      ask,
      capture
    };
  }
}
