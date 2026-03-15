import type { AskWordInput, AskWordResult, LlmProviderName } from "../domain/models";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import type { LlmProvider } from "../../llm/types";
import { ExplanationEngine } from "../explanation/explanation-engine";
import { toAskWordResult } from "../explanation/types";
import { createLlmProvider } from "../../llm/provider-factory";

export class AskWordService {
  private readonly explanationEngine: ExplanationEngine;

  constructor(
    db: SqliteDatabase,
    providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.explanationEngine = new ExplanationEngine(db, providerFactory);
  }

  async ask(
    input: AskWordInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<AskWordResult> {
    const explanation = await this.explanationEngine.explain(input, options);
    return toAskWordResult(explanation);
  }
}
