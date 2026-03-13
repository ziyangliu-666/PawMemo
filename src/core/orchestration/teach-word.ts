import type { TeachWordInput, TeachWordResult, LlmProviderName } from "../domain/models";
import { CaptureWordService } from "./capture-word";
import { EventLogRepository } from "../../storage/repositories/event-log-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import { createLlmProvider } from "../../llm/provider-factory";
import type { LlmProvider } from "../../llm/types";
import { ExplanationEngine } from "../explanation/explanation-engine";
import { toAskWordResult } from "../explanation/types";
import { ExplanationContractError } from "../../lib/errors";

export class TeachWordService {
  private readonly explanationEngine: ExplanationEngine;
  private readonly captureService: CaptureWordService;
  private readonly eventLog: EventLogRepository;

  constructor(
    db: SqliteDatabase,
    providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.explanationEngine = new ExplanationEngine(db, providerFactory);
    this.captureService = new CaptureWordService(db);
    this.eventLog = new EventLogRepository(db);
  }

  async teach(input: TeachWordInput): Promise<TeachWordResult> {
    const explanation = await this.explanationEngine.explain(input);

    if (!explanation.providerGlossAccepted) {
      throw new ExplanationContractError(
        "Provider did not return a usable gloss for `teach`."
      );
    }

    const ask = toAskWordResult(explanation);
    const capture = this.captureService.capture({
      word: input.word,
      context: input.context,
      gloss: explanation.gloss,
      sourceLabel: input.sourceLabel ?? "llm-teach"
    });

    this.eventLog.append(
      "word.taught",
      {
        word: ask.word,
        normalized: ask.normalized,
        provider: ask.provider,
        model: ask.model,
        gloss: ask.gloss,
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
