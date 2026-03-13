import { ProviderRequestError } from "../../lib/errors";
import type { LlmModelInfo } from "../../core/domain/models";
import { normalizeApiUrl } from "../normalize-api-url";
import type {
  LlmModelListRequest,
  LlmProvider,
  LlmTextRequest,
  LlmTextResponse
} from "../types";

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
    const response = await fetch(
      url,
      {
        method: "POST",
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
      }
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

      const response = await fetch(url, {
        headers: baseUrl
          ? {
              authorization: `Bearer ${request.apiKey}`,
              "x-goog-api-key": request.apiKey
            }
          : undefined
      });
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
