import type { ExplainWordInput } from "../explanation/types";
import type { LlmProviderName } from "../domain/models";

export interface AuthorStudyCardsInput extends ExplainWordInput {
  gloss: string;
}

export interface CardAuthorContext {
  word: string;
  normalized: string;
  context: string;
  gloss: string;
  provider: LlmProviderName;
  model: string;
  apiKey: string;
  apiUrl: string | null;
}

export interface CardAuthorPayload {
  status?: string;
  reason?: string;
  normalized_context?: string;
  cloze_context?: string;
}

export interface AuthorStudyCardsResult {
  word: string;
  normalized: string;
  gloss: string;
  provider: LlmProviderName;
  model: string;
  accepted: boolean;
  reason: string | null;
  normalizedContext: string | null;
  clozeContext: string | null;
}
