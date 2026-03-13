import type {
  AskWordResult,
  LlmProviderName,
  MasteryState,
  WordKnowledgeSnapshot
} from "../domain/models";

export interface ExplainWordInput {
  word: string;
  context: string;
  provider?: LlmProviderName;
  model?: string;
  apiKey?: string;
  apiUrl?: string;
}

export interface ExplanationContext {
  word: string;
  normalized: string;
  context: string;
  responseLanguage: "en" | "zh";
  provider: LlmProviderName;
  model: string;
  apiKey: string;
  apiUrl: string | null;
  knowledge: WordKnowledgeSnapshot | null;
  recentWords: string[];
}

export interface ExplainWordOutput {
  word: string;
  normalized: string;
  gloss: string;
  glossSource: "provider" | "retrieved" | "fallback";
  providerGlossAccepted: boolean;
  explanation: string;
  usageNote: string;
  example: string;
  highlights: string[];
  confidenceNote: string;
  responseLanguage: "en" | "zh";
  provider: LlmProviderName;
  model: string;
  knownWord: boolean;
  knownState: MasteryState | null;
  retrievedGloss: string | null;
  recentContextCount: number;
}

export interface ExplanationPayload {
  gloss?: string;
  explanation?: string;
  usage_note?: string;
  example?: string;
  highlights?: string[] | string;
  confidence_note?: string;
}

export function toAskWordResult(output: ExplainWordOutput): AskWordResult {
  return {
    word: output.word,
    normalized: output.normalized,
    gloss: output.gloss,
    explanation: output.explanation,
    usageNote: output.usageNote,
    example: output.example,
    highlights: output.highlights,
    confidenceNote: output.confidenceNote,
    responseLanguage: output.responseLanguage,
    provider: output.provider,
    model: output.model,
    knownWord: output.knownWord,
    knownState: output.knownState,
    retrievedGloss: output.retrievedGloss,
    recentContextCount: output.recentContextCount
  };
}
