import { UsageError } from "../../lib/errors";
import { normalizeApiUrl } from "../../llm/normalize-api-url";
import { resolveApiKey } from "../../llm/resolve-api-key";
import { AppSettingsRepository } from "../../storage/repositories/app-settings-repository";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import type { CardAuthorContext, AuthorStudyCardsInput } from "./types";

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

export class CardAuthorContextBuilder {
  private readonly settings: AppSettingsRepository;

  constructor(db: SqliteDatabase) {
    this.settings = new AppSettingsRepository(db);
  }

  build(input: AuthorStudyCardsInput): CardAuthorContext {
    const word = requireValue("word", input.word);
    const context = requireValue("context", input.context);
    const gloss = requireValue("gloss", input.gloss);
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
    const apiKey = resolveApiKey(provider, input.apiKey, storedApiKey);
    const apiUrl = normalizeApiUrl(input.apiUrl ?? storedApiUrl);

    return {
      word,
      normalized,
      context,
      gloss,
      provider,
      model,
      apiKey,
      apiUrl
    };
  }
}
