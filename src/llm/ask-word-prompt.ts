import type { WordKnowledgeSnapshot } from "../core/domain/models";

export interface AskWordPromptInput {
  word: string;
  context: string;
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

  return {
    systemInstruction: [
      "You are PawMemo's explanation engine.",
      "Explain an English word briefly and clearly for a learner.",
      "Stay factual, warm, and concise.",
      "Do not roleplay romance, emotional manipulation, or fake memories.",
      "Do not say you remember the user unless the prompt gives explicit stored evidence.",
      "Use plain text only inside JSON values. No markdown, bullets, or code fences.",
      "Return JSON only with keys gloss, explanation, usage_note, confidence_note."
    ].join(" "),
    userPrompt: [
      `Target word: ${input.word}`,
      `Current context: ${input.context}`,
      `Known gloss in PawMemo: ${knownGloss}`,
      `Known mastery state: ${knownState}`,
      `Stored contexts for this word: ${storedContexts ? `- ${storedContexts}` : "none"}`,
      `Recent nearby vocabulary in PawMemo: ${recentWords}`,
      "Requirements:",
      "- gloss: 2 to 8 words",
      "- explanation: 1 to 2 sentences focused on this context",
      "- usage_note: one short sentence about common usage or nuance",
      "- confidence_note: one short sentence saying whether the answer depends strongly on the given context",
      "- if you are unsure, keep the confidence_note cautious instead of inventing memory or extra facts"
    ].join("\n")
  };
}
