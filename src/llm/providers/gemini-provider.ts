import { ProviderRequestError } from "../../lib/errors";
import type { LlmModelInfo } from "../../core/domain/models";
import { normalizeApiUrl } from "../normalize-api-url";
import { fetchWithLlmTimeout } from "../fetch-with-timeout";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse,
  LlmTextStreamRequest
} from "../types";
import { collectSseEvents } from "../sse";

interface GeminiTextPart {
  text?: string;
}

interface GeminiCandidate {
  content?: {
    parts?: GeminiTextPart[];
  };
}

interface GeminiGenerateContentResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    message?: string;
  };
}

interface GeminiModelPayload {
  models?: Array<{
    name?: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods?: string[];
  }>;
  nextPageToken?: string;
  error?: {
    message?: string;
  };
}

function getBaseUrl(apiUrl?: string | null): string | null {
  return normalizeApiUrl(apiUrl);
}

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;

  async generateText(request: LlmTextRequest): Promise<LlmTextResponse> {
    const baseUrl = getBaseUrl(request.apiUrl);
    const url = baseUrl
      ? `${baseUrl}/models/${request.model}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent`;
    const response = await fetchWithLlmTimeout(
      url,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          ...(baseUrl
            ? {
                authorization: `Bearer ${request.apiKey}`,
                "x-goog-api-key": request.apiKey
              }
            : {
                "x-goog-api-key": request.apiKey
              })
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: request.systemInstruction }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: request.userPrompt }]
            }
          ],
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            responseMimeType: request.responseMimeType ?? "application/json"
          }
        })
      },
      "Gemini request"
    );

    const payload = (await response.json()) as GeminiGenerateContentResponse;

    if (!response.ok) {
      throw new ProviderRequestError(
        payload.error?.message ?? `Gemini request failed with status ${response.status}.`
      );
    }

    if (payload.promptFeedback?.blockReason) {
      throw new ProviderRequestError(
        `Gemini blocked the request: ${payload.promptFeedback.blockReason}.`
      );
    }

    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new ProviderRequestError("Gemini returned an empty response.");
    }

    return { text };
  }

  async generateTextStream(
    request: LlmTextStreamRequest
  ): Promise<LlmTextResponse> {
    const baseUrl = getBaseUrl(request.apiUrl);
    const url = baseUrl
      ? `${baseUrl}/models/${request.model}:streamGenerateContent?alt=sse`
      : `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:streamGenerateContent?alt=sse`;
    const response = await fetchWithLlmTimeout(
      url,
      {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          ...(baseUrl
            ? {
                authorization: `Bearer ${request.apiKey}`,
                "x-goog-api-key": request.apiKey
              }
            : {
                "x-goog-api-key": request.apiKey
              })
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: request.systemInstruction }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: request.userPrompt }]
            }
          ],
          generationConfig: {
            temperature: request.temperature ?? 0.2
          }
        })
      },
      "Gemini request"
    );

    if (!response.ok) {
      const payload = (await response.json()) as GeminiGenerateContentResponse;
      throw new ProviderRequestError(
        payload.error?.message ?? `Gemini request failed with status ${response.status}.`
      );
    }

    let text = "";

    await collectSseEvents(response, async (event) => {
      const payload = JSON.parse(event.data) as GeminiGenerateContentResponse;

      if (payload.promptFeedback?.blockReason) {
        throw new ProviderRequestError(
          `Gemini blocked the request: ${payload.promptFeedback.blockReason}.`
        );
      }

      const delta = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("");

      if (!delta || delta.length === 0) {
        return;
      }

      text += delta;
      await request.onTextDelta(delta);
    });

    if (text.trim().length === 0) {
      throw new ProviderRequestError("Gemini returned an empty response.");
    }

    return { text: text.trim() };
  }

  async listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]> {
    const models: LlmModelInfo[] = [];
    let nextPageToken: string | null = null;
    const baseUrl = getBaseUrl(request.apiUrl);

    while (true) {
      const url = new URL(
        baseUrl
          ? `${baseUrl}/models`
          : "https://generativelanguage.googleapis.com/v1beta/models"
      );

      if (!baseUrl) {
        url.searchParams.set("key", request.apiKey);
      }

      if (nextPageToken) {
        url.searchParams.set("pageToken", nextPageToken);
      }

      const response = await fetchWithLlmTimeout(
        url,
        {
          signal: request.signal,
          headers: baseUrl
            ? {
                authorization: `Bearer ${request.apiKey}`,
                "x-goog-api-key": request.apiKey
              }
            : undefined
        },
        "Gemini model listing request"
      );
      const payload = (await response.json()) as GeminiModelPayload;

      if (!response.ok) {
        throw new ProviderRequestError(
          payload.error?.message ??
            `Gemini model listing failed with status ${response.status}.`
        );
      }

      models.push(
        ...(payload.models ?? [])
          .filter(
            (model) =>
              typeof model.name === "string" &&
              model.name.trim().length > 0 &&
              (model.supportedGenerationMethods ?? []).includes("generateContent")
          )
          .map((model) => ({
            id: String(model.name).replace(/^models\//, ""),
            provider: this.name,
            displayName:
              typeof model.displayName === "string" ? model.displayName : model.name ?? null,
            createdAt: null,
            ownedBy: "google"
          }))
      );

      if (!payload.nextPageToken) {
        break;
      }

      nextPageToken = payload.nextPageToken;
    }

    return models.sort((left, right) => left.id.localeCompare(right.id));
  }
}
