import type {
  LlmModelInfo,
  LlmProviderName,
  LlmSettings
} from "../core/domain/models";
import { createLlmProvider } from "./provider-factory";
import {
  getDefaultModelForProvider,
  getLlmProviderMetadata,
  listLlmProviderMetadata,
  resolveProviderEnvApiKey
} from "./provider-metadata";
import { resolveApiKey } from "./resolve-api-key";
import type { LlmProvider } from "./types";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import type { SqliteDatabase } from "../storage/sqlite/database";
import { nowIso } from "../lib/time";

export interface LlmProviderStatus {
  provider: LlmProviderName;
  displayName: string;
  selected: boolean;
  model: string;
  defaultModel: string;
  apiKeyPresent: boolean;
  apiUrl: string | null;
}

export interface LlmStatusSummary {
  provider: LlmProviderName;
  model: string;
  providers: LlmProviderStatus[];
}

export interface ListLlmModelsResult {
  provider: LlmProviderName;
  currentProvider: LlmProviderName;
  currentModel: string;
  models: LlmModelInfo[];
}

export class LlmConfigService {
  private readonly settings: AppSettingsRepository;

  constructor(
    db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.settings = new AppSettingsRepository(db);
  }

  getCurrentSettings(): LlmSettings {
    return this.settings.getLlmSettings();
  }

  getStatusSummary(): LlmStatusSummary {
    const current = this.settings.getLlmSettings();

    return {
      provider: current.provider,
      model: current.model,
      providers: listLlmProviderMetadata().map((metadata) => ({
        provider: metadata.name,
        displayName: metadata.displayName,
        selected: metadata.name === current.provider,
        model:
          this.settings.getStoredModel(metadata.name) ??
          (metadata.name === current.provider ? current.model : getDefaultModelForProvider(metadata.name)),
        defaultModel: metadata.defaultModel,
        apiKeyPresent:
          (this.settings.getStoredApiKey(metadata.name)?.trim().length ?? 0) !== 0 ||
          resolveProviderEnvApiKey(metadata.name) !== null,
        apiUrl: this.settings.getStoredApiUrl(metadata.name)
      }))
    };
  }

  updateCurrentSettings(input: {
    provider?: LlmProviderName;
    model?: string;
    apiKey?: string | null;
    apiUrl?: string | null;
  }): LlmSettings {
    const current = this.settings.getLlmSettings();
    const nextProvider = input.provider ?? current.provider;
    const nextModel =
      input.model?.trim() ||
      this.settings.getStoredModel(nextProvider) ||
      getDefaultModelForProvider(nextProvider);

    return this.settings.setLlmSettings(
      {
        provider: nextProvider,
        model: nextModel,
        apiKey: input.apiKey ?? undefined,
        apiUrl: input.apiUrl ?? undefined
      },
      nowIso()
    );
  }

  setProviderApiKey(provider: LlmProviderName, apiKey: string | null): void {
    this.settings.setStoredApiKey(provider, apiKey, nowIso());
  }

  setProviderApiUrl(provider: LlmProviderName, apiUrl: string | null): void {
    this.settings.setStoredApiUrl(provider, apiUrl, nowIso());
  }

  async listModels(input: {
    provider?: LlmProviderName;
    apiKey?: string;
    apiUrl?: string | null;
  } = {}): Promise<ListLlmModelsResult> {
    const current = this.settings.getLlmSettings();
    const provider = input.provider ?? current.provider;
    const apiKey = resolveApiKey(
      provider,
      input.apiKey,
      this.settings.getStoredApiKey(provider)
    );
    const apiUrl =
      input.apiUrl ??
      this.settings.getStoredApiUrl(provider) ??
      (provider === current.provider ? current.apiUrl : null);
    const models = await this.providerFactory(provider).listModels({
      apiKey,
      apiUrl
    });

    return {
      provider,
      currentProvider: current.provider,
      currentModel:
        provider === current.provider
          ? current.model
          : this.settings.getStoredModel(provider) ?? getDefaultModelForProvider(provider),
      models
    };
  }

  describeProvider(provider: LlmProviderName): LlmProviderStatus {
    const metadata = getLlmProviderMetadata(provider);

    return {
      provider,
      displayName: metadata.displayName,
      selected: provider === this.settings.getLlmSettings().provider,
      model:
        this.settings.getStoredModel(provider) ?? getDefaultModelForProvider(provider),
      defaultModel: metadata.defaultModel,
      apiKeyPresent:
        (this.settings.getStoredApiKey(provider)?.trim().length ?? 0) !== 0 ||
        resolveProviderEnvApiKey(provider) !== null,
      apiUrl: this.settings.getStoredApiUrl(provider)
    };
  }
}
