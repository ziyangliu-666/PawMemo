import { buildCardAuthorPrompt } from "../../llm/card-author-prompt";
import { createLlmProvider } from "../../llm/provider-factory";
import { parseStructuredJson } from "../../llm/structured-output";
import type { LlmProvider } from "../../llm/types";
import type { LlmProviderName } from "../domain/models";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import { normalizeCardAuthorOutput } from "./normalize";
import type {
  AuthorStudyCardsInput,
  AuthorStudyCardsResult,
  CardAuthorPayload
} from "./types";
import { CardAuthorContextBuilder } from "./context-builder";

function toCardAuthorPayload(payload: Record<string, unknown>): CardAuthorPayload {
  return {
    status: typeof payload.status === "string" ? payload.status : undefined,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    normalized_context:
      typeof payload.normalized_context === "string"
        ? payload.normalized_context
        : undefined,
    cloze_context:
      typeof payload.cloze_context === "string"
        ? payload.cloze_context
        : undefined
  };
}

export class CardAuthorEngine {
  private readonly contextBuilder: CardAuthorContextBuilder;

  constructor(
    db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.contextBuilder = new CardAuthorContextBuilder(db);
  }

  async author(
    input: AuthorStudyCardsInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<AuthorStudyCardsResult> {
    const context = this.contextBuilder.build(input);
    const prompt = buildCardAuthorPrompt({
      word: context.word,
      gloss: context.gloss,
      context: context.context
    });
    const provider = this.providerFactory(context.provider);
    const response = await provider.generateText({
      model: context.model,
      apiKey: context.apiKey,
      apiUrl: context.apiUrl,
      signal: options.signal,
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      responseMimeType: "application/json",
      temperature: 0.1
    });
    const payload = parseStructuredJson(response.text, toCardAuthorPayload);

    return normalizeCardAuthorOutput(context, payload);
  }
}
