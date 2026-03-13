import { UsageError } from "../../lib/errors";
import { resolveApiKey } from "../../llm/resolve-api-key";
import { normalizeApiUrl } from "../../llm/normalize-api-url";
import { AppSettingsRepository } from "../../storage/repositories/app-settings-repository";
import { WordQueryRepository } from "../../storage/repositories/word-query-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import type { ExplainWordInput, ExplanationContext } from "./types";

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function requireValue(name: string, value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new UsageError(`${name} must not be empty.`);
  }

  return trimmed;
}

export class ExplanationContextBuilder {
  private readonly settings: AppSettingsRepository;
  private readonly words: WordQueryRepository;

  constructor(private readonly db: SqliteDatabase) {
    this.settings = new AppSettingsRepository(db);
    this.words = new WordQueryRepository(db);
  }

  build(input: ExplainWordInput): ExplanationContext {
    const word = requireValue("word", input.word);
    const context = requireValue("context", input.context);
    const normalized = normalizeWord(word);
    const storedSettings = this.settings.getLlmSettings();
    const provider = input.provider ?? storedSettings.provider;
    const model = input.model ?? storedSettings.model;
    const storedApiKey =
      provider === storedSettings.provider
        ? storedSettings.apiKey
        : this.settings.getStoredApiKey(provider);
    const storedApiUrl =
      provider === storedSettings.provider
        ? storedSettings.apiUrl
        : this.settings.getStoredApiUrl(provider);
    const apiKey = resolveApiKey(
      provider,
      input.apiKey,
      storedApiKey
    );
    const apiUrl = normalizeApiUrl(input.apiUrl ?? storedApiUrl);
    const knowledge = this.words.getKnowledgeByNormalized(normalized);
    const recentWords = this.words
      .listRecentWords(3)
      .filter((recentWord) => recentWord.toLowerCase() !== normalized)
      .slice(0, 3);

    return {
      word,
      normalized,
      context,
      provider,
      model,
      apiKey,
      apiUrl,
      knowledge,
      recentWords
    };
  }
}
