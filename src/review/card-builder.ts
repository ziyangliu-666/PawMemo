import type { ReviewCardType } from "../core/domain/models";

export interface CardSeed {
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
}

export interface BuildCardSeedsInput {
  word: string;
  context: string;
  gloss: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildClozeContext(word: string, context: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");

  if (!pattern.test(context)) {
    return `${context}\nTarget word: ____`;
  }

  return context.replace(pattern, "____");
}

export function buildCardSeeds(input: BuildCardSeedsInput): CardSeed[] {
  const normalizedWord = input.word.trim();
  const normalizedGloss = input.gloss.trim();
  const normalizedContext = input.context.trim();
  const clozeContext = buildClozeContext(normalizedWord, normalizedContext);

  return [
    {
      cardType: "recognition",
      promptText: `What does "${normalizedWord}" mean in this context?\n${normalizedContext}`,
      answerText: normalizedGloss
    },
    {
      cardType: "cloze",
      promptText: `Fill the missing word.\n${clozeContext}`,
      answerText: `${normalizedWord}\nMeaning: ${normalizedGloss}`
    }
  ];
}
