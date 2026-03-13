export interface CardAuthorPromptInput {
  word: string;
  gloss: string;
  context: string;
}

export interface CardAuthorPrompt {
  systemInstruction: string;
  userPrompt: string;
}

export function buildCardAuthorPrompt(input: CardAuthorPromptInput): CardAuthorPrompt {
  return {
    systemInstruction: [
      "You are PawMemo's study-card author.",
      "Rewrite rough learner context into one clean study sentence without changing the target meaning.",
      "Follow the minimum information principle: one sentence, one meaning, one cloze blank at most.",
      "If the source context is too broken to support a clear sentence, ask for clarification instead of guessing.",
      "Use plain text only inside JSON values. No markdown, bullets, or code fences.",
      "Return JSON only with keys status, reason, normalized_context, cloze_context."
    ].join(" "),
    userPrompt: [
      `Target word: ${input.word}`,
      `Accepted gloss: ${input.gloss}`,
      `Raw captured context: ${input.context}`,
      "Requirements:",
      '- status must be "ok" or "clarify"',
      "- reason should be empty when status is ok, otherwise briefly explain what is unclear",
      "- normalized_context must be one short natural sentence that preserves the intended sense",
      "- normalized_context should usually stay under 18 words",
      '- cloze_context must be the same sentence with exactly one blank written as "____"',
      "- cloze_context must hide only the target word or a short target phrase",
      "- do not create multiple blanks",
      "- do not turn fragments into a different meaning just to sound cleaner",
      "- if the target word is not actually supported by the context, return clarify",
      '- example ok output: {"status":"ok","reason":"","normalized_context":"The facilitator kept the discussion moving smoothly.","cloze_context":"The ____ kept the discussion moving smoothly."}'
    ].join("\n")
  };
}
