import type { LlmModelInfo, LlmProviderName } from "../core/domain/models";

export interface LlmTextRequest {
  model: string;
  apiKey: string;
  apiUrl?: string | null;
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  responseMimeType?: string;
}

export interface LlmTextResponse {
  text: string;
}

export interface LlmModelListRequest {
  apiKey: string;
  apiUrl?: string | null;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  generateText(request: LlmTextRequest): Promise<LlmTextResponse>;
  listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]>;
}
