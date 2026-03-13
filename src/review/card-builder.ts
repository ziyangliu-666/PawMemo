import type { ReviewCardDraft, ReviewCardType } from "../core/domain/models";
import type { CardPromptLanguage } from "./card-language";

export interface BuildCardSeedsInput {
  word: string;
  context: string;
  gloss: string;
  promptLanguage?: CardPromptLanguage;
  clozeContext?: string | null;
  cardTypes?: ReviewCardType[];
}

function buildRecognitionPrompt(
  word: string,
  context: string,
  language: CardPromptLanguage
): string {
  if (language === "zh") {
    return `这里的“${word}”是什么意思？\n${context}`;
  }

  return `What does "${word}" mean in this context?\n${context}`;
}

function buildClozePrompt(context: string, language: CardPromptLanguage): string {
  if (language === "zh") {
    return `填空。\n${context}`;
  }

  return `Fill the missing word.\n${context}`;
}

function buildClozeAnswer(
  word: string,
  gloss: string,
  language: CardPromptLanguage
): string {
  if (language === "zh") {
    return `${word}\n意思：${gloss}`;
  }

  return `${word}\nMeaning: ${gloss}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildClozeContext(
  word: string,
  context: string,
  authoredClozeContext?: string | null
): string {
  if (authoredClozeContext && authoredClozeContext.trim().length > 0) {
    return authoredClozeContext.trim();
  }

  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, "i");

  if (!pattern.test(context)) {
    return `${context}\nTarget word: ____`;
  }

  return context.replace(pattern, "____");
}

export function buildCardSeeds(input: BuildCardSeedsInput): ReviewCardDraft[] {
  const normalizedWord = input.word.trim();
  const normalizedGloss = input.gloss.trim();
  const normalizedContext = input.context.trim();
  const promptLanguage = input.promptLanguage ?? "en";
  const clozeContext = buildClozeContext(
    normalizedWord,
    normalizedContext,
    input.clozeContext
  );

  const cards: ReviewCardDraft[] = [
    {
      cardType: "recognition",
      promptText: buildRecognitionPrompt(
        normalizedWord,
        normalizedContext,
        promptLanguage
      ),
      answerText: normalizedGloss
    },
    {
      cardType: "cloze",
      promptText: buildClozePrompt(clozeContext, promptLanguage),
      answerText: buildClozeAnswer(normalizedWord, normalizedGloss, promptLanguage)
    }
  ];

  if (!input.cardTypes || input.cardTypes.length === 0) {
    return cards;
  }

  const allowed = new Set(input.cardTypes);
  return cards.filter((card) => allowed.has(card.cardType));
}
