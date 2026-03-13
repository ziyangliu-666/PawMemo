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

export class ExplanationEngine {
  private readonly contextBuilder: ExplanationContextBuilder;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.contextBuilder = new ExplanationContextBuilder(db);
  }

  async explain(input: ExplainWordInput): Promise<ExplainWordOutput> {
    const context = this.contextBuilder.build(input);
    const prompt = buildAskWordPrompt({
      word: context.word,
      context: context.context,
      knowledge: context.knowledge,
      recentWords: context.recentWords
    });
    const provider = this.providerFactory(context.provider);
    const response = await provider.generateText({
      model: context.model,
      apiKey: context.apiKey,
      apiUrl: context.apiUrl,
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      responseMimeType: "application/json",
      temperature: 0.2
    });
    const payload = parseStructuredJson<ExplanationPayload>(response.text);

    return normalizeExplanationOutput(context, payload);
  }
}
