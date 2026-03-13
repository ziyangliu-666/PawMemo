import { ProviderRequestError } from "../../lib/errors";
import type { LlmModelInfo } from "../../core/domain/models";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
  LlmTextStreamRequest
} from "../types";
import { normalizeApiUrl } from "../normalize-api-url";
import { fetchWithLlmTimeout } from "../fetch-with-timeout";
import { collectSseEvents } from "../sse";

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
  delta?: {
    text?: string;
  };
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
    const response = await fetchWithLlmTimeout(
      `${getBaseUrl(request.apiUrl)}/messages`,
      {
        method: "POST",
        signal: request.signal,
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
      },
      "Anthropic request"
    );

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

  async generateTextStream(
    request: LlmTextStreamRequest
  ): Promise<LlmTextResponse> {
    const response = await fetchWithLlmTimeout(
      `${getBaseUrl(request.apiUrl)}/messages`,
      {
        method: "POST",
        signal: request.signal,
        headers: createHeaders(request.apiKey),
        body: JSON.stringify({
          model: request.model,
          max_tokens: 1024,
          temperature: request.temperature ?? 0.2,
          stream: true,
          system: request.systemInstruction,
          messages: [
            {
              role: "user",
              content: request.userPrompt
            }
          ]
        })
      },
      "Anthropic request"
    );

    if (!response.ok) {
      const payload = (await response.json()) as AnthropicErrorPayload;
      throw new ProviderRequestError(
        payload.error?.message ??
          `Anthropic request failed with status ${response.status}.`
      );
    }

    let text = "";

    await collectSseEvents(response, async (event) => {
      if (event.data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(event.data) as AnthropicMessagesPayload;
      const delta =
        event.event === "content_block_delta" &&
        typeof payload.delta?.text === "string"
          ? payload.delta.text
          : null;

      if (!delta) {
        return;
      }

      text += delta;
      await request.onTextDelta(delta);
    });

    if (text.trim().length === 0) {
      throw new ProviderRequestError("Anthropic returned an empty response.");
    }

    return { text: text.trim() };
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

      const response = await fetchWithLlmTimeout(
        url,
        {
          method: "GET",
          signal: request.signal,
          headers: createHeaders(request.apiKey)
        },
        "Anthropic model listing request"
      );

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
