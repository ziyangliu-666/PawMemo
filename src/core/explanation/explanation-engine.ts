import { buildAskWordPrompt } from "../../llm/ask-word-prompt";
import { createLlmProvider } from "../../llm/provider-factory";
import { parseStructuredJson } from "../../llm/structured-output";
import type { LlmProvider } from "../../llm/types";
import type { LlmProviderName } from "../domain/models";
import { normalizeExplanationOutput } from "./normalize";
import type {
  ExplainWordInput,
  ExplainWordOutput,
  ExplanationPayload
} from "./types";
import { ExplanationContextBuilder } from "./context-builder";
import type { SqliteDatabase } from "../../storage/sqlite/database";

function toExplanationPayload(
  payload: Record<string, unknown>
): ExplanationPayload {
  const highlights = payload.highlights;

  return {
    gloss: typeof payload.gloss === "string" ? payload.gloss : undefined,
    explanation:
      typeof payload.explanation === "string" ? payload.explanation : undefined,
    usage_note:
      typeof payload.usage_note === "string" ? payload.usage_note : undefined,
    example: typeof payload.example === "string" ? payload.example : undefined,
    highlights:
      typeof highlights === "string" ||
      (Array.isArray(highlights) && highlights.every((item) => typeof item === "string"))
        ? highlights
        : undefined,
    confidence_note:
      typeof payload.confidence_note === "string"
        ? payload.confidence_note
        : undefined
  };
}

export class ExplanationEngine {
  private readonly contextBuilder: ExplanationContextBuilder;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.contextBuilder = new ExplanationContextBuilder(db);
  }

  async explain(
    input: ExplainWordInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<ExplainWordOutput> {
    const context = this.contextBuilder.build(input);
    const prompt = buildAskWordPrompt({
      word: context.word,
      context: context.context,
      responseLanguage: context.responseLanguage,
      knowledge: context.knowledge,
      recentWords: context.recentWords
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
      temperature: 0.2
    });
    const payload = parseStructuredJson(response.text, toExplanationPayload);

    return normalizeExplanationOutput(context, payload);
  }
}
