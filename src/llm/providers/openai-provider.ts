import { ProviderRequestError } from "../../lib/errors";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse
} from "../types";
import type { LlmModelInfo } from "../../core/domain/models";
import { normalizeApiUrl } from "../normalize-api-url";

interface OpenAiErrorPayload {
  error?: {
    message?: string;
  };
}

interface OpenAiChatPayload extends OpenAiErrorPayload {
  choices?: Array<{
    message?: {
      content?: OpenAiMessageContent;
    };
  }>;
}

type OpenAiMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

interface OpenAiModelsPayload extends OpenAiErrorPayload {
  data?: Array<{
    id?: string;
    created?: number;
    owned_by?: string;
  }>;
}

function getBaseUrl(apiUrl?: string | null): string {
  return normalizeApiUrl(apiUrl) ?? "https://api.openai.com/v1";
}

function readMessageContent(content: OpenAiMessageContent | undefined): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }

  const text = content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim();

  return text && text.length > 0 ? text : null;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    const response = await fetch(`${getBaseUrl(request.apiUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${request.apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        temperature: request.temperature ?? 0.2,
        messages: [
          {
            role: "system",
            content: request.systemInstruction
          },
          {
            role: "user",
            content: request.userPrompt
          }
        ],
        response_format:
          request.responseMimeType === "application/json"
            ? { type: "json_object" }
            : undefined
      })
    });

    const payload = (await response.json()) as OpenAiChatPayload;

    if (!response.ok) {
      throw new ProviderRequestError(
        payload.error?.message ?? `OpenAI request failed with status ${response.status}.`
      );
    }

    const text = readMessageContent(payload.choices?.[0]?.message?.content);

    if (!text) {
      throw new ProviderRequestError("OpenAI returned an empty response.");
    }

    return { text };
  }

  async listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]> {
    const response = await fetch(`${getBaseUrl(request.apiUrl)}/models`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${request.apiKey}`
      }
    });

    const payload = (await response.json()) as OpenAiModelsPayload;

    if (!response.ok) {
      throw new ProviderRequestError(
        payload.error?.message ??
          `OpenAI model listing failed with status ${response.status}.`
      );
    }

    return (payload.data ?? [])
      .filter((model) => typeof model.id === "string" && model.id.trim().length > 0)
      .map((model) => ({
        id: model.id as string,
        provider: this.name,
        displayName: model.id as string,
        createdAt:
          typeof model.created === "number"
            ? new Date(model.created * 1000).toISOString()
            : null,
        ownedBy: typeof model.owned_by === "string" ? model.owned_by : null
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
