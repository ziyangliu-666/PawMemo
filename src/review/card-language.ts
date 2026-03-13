export type CardPromptLanguage = "en" | "zh";

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/u;

export function detectCardPromptLanguage(input: string): CardPromptLanguage {
  return HAN_CHARACTER_PATTERN.test(input) ? "zh" : "en";
}
