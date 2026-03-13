import { ProviderRequestError } from "../../lib/errors";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
  LlmTextStreamRequest
} from "../types";
import type { LlmModelInfo } from "../../core/domain/models";
import { normalizeApiUrl } from "../normalize-api-url";
import { fetchWithLlmTimeout } from "../fetch-with-timeout";
import { collectSseEvents } from "../sse";

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
    delta?: {
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
  return readMessageContentInternal(content, true);
}

function readMessageDelta(content: OpenAiMessageContent | undefined): string | null {
  return readMessageContentInternal(content, false);
}

function readMessageContentInternal(
  content: OpenAiMessageContent | undefined,
  trim: boolean
): string | null {
  if (typeof content === "string") {
    return trim ? content.trim() || null : content.length > 0 ? content : null;
  }

  const text = content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("");

  if (!text || text.length === 0) {
    return null;
  }

  return trim ? text.trim() || null : text;
}

export class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    const response = await fetchWithLlmTimeout(
      `${getBaseUrl(request.apiUrl)}/chat/completions`,
      {
        method: "POST",
        signal: request.signal,
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
      },
      "OpenAI request"
    );

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

  async generateTextStream(
    request: LlmTextStreamRequest
  ): Promise<LlmTextResponse> {
    const response = await fetchWithLlmTimeout(
      `${getBaseUrl(request.apiUrl)}/chat/completions`,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${request.apiKey}`
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature ?? 0.2,
          stream: true,
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
      },
      "OpenAI request"
    );

    if (!response.ok) {
      const payload = (await response.json()) as OpenAiErrorPayload;
      throw new ProviderRequestError(
        payload.error?.message ?? `OpenAI request failed with status ${response.status}.`
      );
    }

    let text = "";

    await collectSseEvents(response, async (event) => {
      if (event.data === "[DONE]") {
        return;
      }

      const payload = JSON.parse(event.data) as OpenAiChatPayload;
      const delta = readMessageDelta(payload.choices?.[0]?.delta?.content);

      if (!delta) {
        return;
      }

      text += delta;
      await request.onTextDelta(delta);
    });

    if (text.trim().length === 0) {
      throw new ProviderRequestError("OpenAI returned an empty response.");
    }

    return { text: text.trim() };
  }

  async listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]> {
    const response = await fetchWithLlmTimeout(
      `${getBaseUrl(request.apiUrl)}/models`,
      {
        method: "GET",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${request.apiKey}`
        }
      },
      "OpenAI model listing request"
    );

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
