import type { WordKnowledgeSnapshot } from "../core/domain/models";

export interface AskWordPromptInput {
  word: string;
  context: string;
  responseLanguage: "en" | "zh";
  knowledge: WordKnowledgeSnapshot | null;
  recentWords: string[];
}

export interface AskWordPrompt {
  systemInstruction: string;
  userPrompt: string;
}

export function buildAskWordPrompt(input: AskWordPromptInput): AskWordPrompt {
  const knownGloss = input.knowledge?.sense?.gloss ?? "none";
  const knownState = input.knowledge?.mastery?.state ?? "unknown";
  const storedContexts =
    input.knowledge?.recentEncounters.map((encounter) => encounter.contextText).join("\n- ") ??
    "";
  const recentWords = input.recentWords.length > 0 ? input.recentWords.join(", ") : "none";
  const languageLabel = input.responseLanguage === "zh" ? "Chinese" : "English";

  return {
    systemInstruction: [
      "You are PawMemo's explanation engine.",
      "Explain an English word briefly and clearly for a learner.",
      "Stay factual, warm, and concise.",
      "Do not roleplay romance, emotional manipulation, or fake memories.",
      "Do not say you remember the user unless the prompt gives explicit stored evidence.",
      "Use plain text only inside JSON values. No markdown, bullets, or code fences.",
      `Write learner-facing fields in natural ${languageLabel}. Keep the target English word unchanged.`,
      "Return JSON only with keys gloss, explanation, usage_note, example, highlights, confidence_note."
    ].join(" "),
    userPrompt: [
      `Target word: ${input.word}`,
      `Current context: ${input.context}`,
      `Learner-facing response language: ${input.responseLanguage}`,
      `Known gloss in PawMemo: ${knownGloss}`,
      `Known mastery state: ${knownState}`,
      `Stored contexts for this word: ${storedContexts ? `- ${storedContexts}` : "none"}`,
      `Recent nearby vocabulary in PawMemo: ${recentWords}`,
      "Requirements:",
      "- gloss: 2 to 8 words",
      "- explanation: 1 short sentence focused on this context",
      "- usage_note: one short sentence about tone, register, or common nuance",
      "- example: one short example sentence that is easy to read",
      "- highlights: array with 1 to 3 short phrases worth visually spotlighting",
      "- confidence_note: one short sentence saying whether the answer depends strongly on the given context",
      "- keep every field compact and scannable; avoid essay-like wording",
      "- if you are unsure, keep the confidence_note cautious instead of inventing memory or extra facts"
    ].join("\n")
  };
}
