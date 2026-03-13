import { ProviderRequestError } from "../../lib/errors";
import type { LlmModelInfo } from "../../core/domain/models";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse
} from "../types";
import { normalizeApiUrl } from "../normalize-api-url";

interface AnthropicErrorPayload {
  error?: {
    message?: string;
  };
}

interface AnthropicMessagesPayload extends AnthropicErrorPayload {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
}

interface AnthropicModelPage extends AnthropicErrorPayload {
  data?: Array<{
    id?: string;
    display_name?: string;
    created_at?: string;
  }>;
  has_more?: boolean;
  last_id?: string;
}

function createHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01"
  };
}

function getBaseUrl(apiUrl?: string | null): string {
  return normalizeApiUrl(apiUrl) ?? "https://api.anthropic.com/v1";
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    const response = await fetch(`${getBaseUrl(request.apiUrl)}/messages`, {
      method: "POST",
      headers: createHeaders(request.apiKey),
      body: JSON.stringify({
        model: request.model,
        max_tokens: 1024,
        temperature: request.temperature ?? 0.2,
        system: request.systemInstruction,
        messages: [
          {
            role: "user",
            content: request.userPrompt
          }
        ]
      })
    });

    const payload = (await response.json()) as AnthropicMessagesPayload;

    if (!response.ok) {
      throw new ProviderRequestError(
        payload.error?.message ??
          `Anthropic request failed with status ${response.status}.`
      );
    }

    const text = payload.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new ProviderRequestError("Anthropic returned an empty response.");
    }

    return { text };
  }

  async listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]> {
    const models: LlmModelInfo[] = [];
    let nextAfterId: string | null = null;

    while (true) {
      const baseUrl = getBaseUrl(request.apiUrl);
      const url = new URL(`${baseUrl}/models`);
      url.searchParams.set("limit", "100");

      if (nextAfterId) {
        url.searchParams.set("after_id", nextAfterId);
      }

      const response = await fetch(url, {
        method: "GET",
        headers: createHeaders(request.apiKey)
      });

      const payload = (await response.json()) as AnthropicModelPage;

      if (!response.ok) {
        throw new ProviderRequestError(
          payload.error?.message ??
            `Anthropic model listing failed with status ${response.status}.`
        );
      }

      models.push(
        ...(payload.data ?? [])
          .filter((model) => typeof model.id === "string" && model.id.trim().length > 0)
          .map((model) => ({
            id: model.id as string,
            provider: this.name,
            displayName:
              typeof model.display_name === "string" ? model.display_name : model.id ?? null,
            createdAt:
              typeof model.created_at === "string" ? model.created_at : null,
            ownedBy: "anthropic"
          }))
      );

      if (!payload.has_more || typeof payload.last_id !== "string") {
        break;
      }

      nextAfterId = payload.last_id;
    }

    return models.sort((left, right) => left.id.localeCompare(right.id));
  }
}
