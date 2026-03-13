import type { LlmProviderName } from "../core/domain/models";
import { ConfigurationError } from "../lib/errors";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { GeminiProvider } from "./providers/gemini-provider";
import { OpenAiProvider } from "./providers/openai-provider";
import type { LlmProvider } from "./types";

const SUPPORTED_PROVIDERS = new Set<LlmProviderName>([
  "gemini",
  "openai",
  "anthropic"
]);

function unreachableProvider(name: never): never {
  void name;
  throw new ConfigurationError("Unsupported LLM provider.");
}

export function isLlmProviderName(value: string): value is LlmProviderName {
  return SUPPORTED_PROVIDERS.has(value as LlmProviderName);
}

export function createLlmProvider(name: LlmProviderName): LlmProvider {
  switch (name) {
    case "gemini":
      return new GeminiProvider();
    case "openai":
      return new OpenAiProvider();
    case "anthropic":
      return new AnthropicProvider();
    default:
      return unreachableProvider(name);
  }
}
