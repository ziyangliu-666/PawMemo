import type {
  AppSettingRecord,
  LlmSettings
} from "../../core/domain/models";
import { ConfigurationError } from "../../lib/errors";
import { isLlmProviderName } from "../../llm/provider-factory";
import { getDefaultModelForProvider } from "../../llm/provider-metadata";
import type { SqliteDatabase } from "../sqlite/database";
import { normalizeApiUrl } from "../../llm/normalize-api-url";

function mapSetting(row: Record<string, unknown>): AppSettingRecord {
  return {
    key: String(row.key),
    value: String(row.value),
    updatedAt: String(row.updated_at)
  };
}

export class AppSettingsRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private apiKeySettingKey(provider: string): string {
    return `llm.api_key.${provider}`;
  }

  private modelSettingKey(provider: string): string {
    return `llm.model.${provider}`;
  }

  private apiUrlSettingKey(provider: string): string {
    return `llm.api_url.${provider}`;
  }

  list(): AppSettingRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT key, value, updated_at
          FROM app_settings
          ORDER BY key ASC
        `
      )
      .all() as Record<string, unknown>[];

    return rows
      .map(mapSetting)
      .map((setting) =>
        setting.key.startsWith("llm.api_key.")
          ? {
              ...setting,
              value: "<redacted>"
            }
          : setting
      );
  }

  get(key: string): AppSettingRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT key, value, updated_at
          FROM app_settings
          WHERE key = ?
        `
      )
      .get(key) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return mapSetting(row);
  }

  set(key: string, value: string, updatedAt: string): AppSettingRecord {
    this.db.prepare(
      `
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (@key, @value, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `
    ).run({
      key,
      value,
      updatedAt
    });

    return this.get(key) as AppSettingRecord;
  }

  getLlmSettings(): LlmSettings {
    const rawProvider = this.get("llm.provider")?.value ?? "gemini";

    if (!isLlmProviderName(rawProvider)) {
      throw new ConfigurationError(`Unsupported LLM provider in settings: ${rawProvider}`);
    }

    const model =
      this.get(this.modelSettingKey(rawProvider))?.value ??
      this.get("llm.model")?.value ??
      getDefaultModelForProvider(rawProvider);

    return {
      provider: rawProvider,
      model,
      apiKey: this.getStoredApiKey(rawProvider),
      apiUrl: this.getStoredApiUrl(rawProvider)
    };
  }

  setLlmSettings(
    settings: Pick<LlmSettings, "provider" | "model"> & {
      apiKey?: string | null;
      apiUrl?: string | null;
    },
    updatedAt: string
  ): LlmSettings {
    this.set("llm.provider", settings.provider, updatedAt);
    this.set("llm.model", settings.model, updatedAt);
    this.set(this.modelSettingKey(settings.provider), settings.model, updatedAt);

    if (settings.apiKey !== undefined) {
      this.setStoredApiKey(settings.provider, settings.apiKey, updatedAt);
    }

    if (settings.apiUrl !== undefined) {
      this.setStoredApiUrl(settings.provider, settings.apiUrl, updatedAt);
    }

    return this.getLlmSettings();
  }

  getStoredApiKey(provider: string): string | null {
    return this.get(this.apiKeySettingKey(provider))?.value ?? null;
  }

  getStoredModel(provider: string): string | null {
    return this.get(this.modelSettingKey(provider))?.value ?? null;
  }

  getStoredApiUrl(provider: string): string | null {
    return this.get(this.apiUrlSettingKey(provider))?.value ?? null;
  }

  setStoredApiUrl(
    provider: string,
    apiUrl: string | null,
    updatedAt: string
  ): string | null {
    const key = this.apiUrlSettingKey(provider);
    const normalized = normalizeApiUrl(apiUrl);

    if (normalized === null) {
      this.db.prepare(
        `
          DELETE FROM app_settings
          WHERE key = ?
        `
      ).run(key);
      return null;
    }

    this.set(key, normalized, updatedAt);
    return this.getStoredApiUrl(provider);
  }

  setStoredApiKey(
    provider: string,
    apiKey: string | null,
    updatedAt: string
  ): string | null {
    const key = this.apiKeySettingKey(provider);

    if (apiKey === null || apiKey.trim().length === 0) {
      this.db.prepare(
        `
          DELETE FROM app_settings
          WHERE key = ?
        `
      ).run(key);
      return null;
    }

    this.set(key, apiKey.trim(), updatedAt);
    return this.getStoredApiKey(provider);
  }

  hasAnyStoredApiKey(): boolean {
    const row = this.db.prepare(
      `
        SELECT 1 AS present
        FROM app_settings
        WHERE key LIKE 'llm.api_key.%'
        LIMIT 1
      `
    ).get() as Record<string, unknown> | undefined;

    return Boolean(row);
  }

  getCompanionPackId(): string {
    return this.get("companion.pack_id")?.value ?? "momo";
  }

  setCompanionPackId(packId: string, updatedAt: string): string {
    this.set("companion.pack_id", packId, updatedAt);
    return this.getCompanionPackId();
  }
}
