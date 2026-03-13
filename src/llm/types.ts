import type { LlmModelInfo, LlmProviderName } from "../core/domain/models";

export interface LlmTextRequest {
  model: string;
  apiKey: string;
  apiUrl?: string | null;
  signal?: AbortSignal;
  systemInstruction: string;
  userPrompt: string;
  temperature?: number;
  responseMimeType?: string;
}

export interface LlmTextResponse {
  text: string;
}

export interface LlmTextStreamRequest extends LlmTextRequest {
  onTextDelta: (delta: string) => void | Promise<void>;
}

export interface LlmModelListRequest {
  apiKey: string;
  apiUrl?: string | null;
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  generateText(request: LlmTextRequest): Promise<LlmTextResponse>;
  generateTextStream?(
    request: LlmTextStreamRequest
  ): Promise<LlmTextResponse>;
  listModels(request: LlmModelListRequest): Promise<LlmModelInfo[]>;
}
