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
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.explanationEngine = new ExplanationEngine(db, providerFactory);
  }

  async ask(input: AskWordInput): Promise<AskWordResult> {
    const explanation = await this.explanationEngine.explain(input);
    return toAskWordResult(explanation);
  }
}
