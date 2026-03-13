import type { LlmProviderName } from "../core/domain/models";
import { ConfigurationError } from "../lib/errors";
import { getLlmProviderMetadata, resolveProviderEnvApiKey } from "./provider-metadata";

export function resolveApiKey(
  provider: LlmProviderName,
  explicitApiKey?: string,
  storedApiKey?: string | null
): string {
  if (explicitApiKey && explicitApiKey.trim().length > 0) {
    return explicitApiKey.trim();
  }

  if (storedApiKey && storedApiKey.trim().length > 0) {
    return storedApiKey.trim();
  }

  const envKey = resolveProviderEnvApiKey(provider);

  if (!envKey) {
    const metadata = getLlmProviderMetadata(provider);

    throw new ConfigurationError(
      `${metadata.displayName} API key is missing. Set ${metadata.envVarNames.join(" or ")}, or pass --api-key.`
    );
  }

  return envKey;
}
