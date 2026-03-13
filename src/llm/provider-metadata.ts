import type { LlmProviderName } from "../core/domain/models";

export interface LlmProviderMetadata {
  name: LlmProviderName;
  displayName: string;
  defaultModel: string;
  envVarNames: string[];
}

const PROVIDER_METADATA: Record<LlmProviderName, LlmProviderMetadata> = {
  gemini: {
    name: "gemini",
    displayName: "Google Gemini",
    defaultModel: "gemini-2.5-flash",
    envVarNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
  },
  openai: {
    name: "openai",
    displayName: "OpenAI",
    defaultModel: "gpt-5-mini",
    envVarNames: ["OPENAI_API_KEY"]
  },
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic",
    defaultModel: "claude-sonnet-4-20250514",
    envVarNames: ["ANTHROPIC_API_KEY"]
  }
};

export function getLlmProviderMetadata(
  provider: LlmProviderName
): LlmProviderMetadata {
  return PROVIDER_METADATA[provider];
}

export function listLlmProviderMetadata(): LlmProviderMetadata[] {
  return (Object.keys(PROVIDER_METADATA) as LlmProviderName[]).map(
    (provider) => PROVIDER_METADATA[provider]
  );
}

export function getDefaultModelForProvider(provider: LlmProviderName): string {
  return getLlmProviderMetadata(provider).defaultModel;
}

export function resolveProviderEnvApiKey(
  provider: LlmProviderName
): string | null {
  const metadata = getLlmProviderMetadata(provider);

  for (const envVarName of metadata.envVarNames) {
    const value = process.env[envVarName]?.trim();

    if (value) {
      return value;
    }
  }

  return null;
}

export function hasAnyProviderEnvApiKey(): boolean {
  return listLlmProviderMetadata().some(
    (metadata) =>
      metadata.envVarNames.some((envVarName) => {
        const value = process.env[envVarName]?.trim();
        return Boolean(value);
      })
  );
}
