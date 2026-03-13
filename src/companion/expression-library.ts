import type { CompanionMood, CompanionPackDefinition } from "./types";

const SHARED_EXPRESSION_FRAMES: Record<CompanionMood, string[]> = {
  idle: ["(•ᴗ•)", "(◕ᴗ◕)", "(˘ᴗ˘)", "(•‿•)"],
  curious: ["(•ᴗ•?)", "(◔ᴗ◔)", "(•ω•)", "(°ᴗ°)"],
  studying: ["(•ᴗ•)", "(˘◡˘)", "(•‿•)", "(-ᴗ-)"],
  proud: ["(ᵔᴗᵔ)", "(˘ᴗ˘)", "(^ᴗ^)", "(•‿•)"],
  confused: ["(•︵•)", "(•_•)", "(˘ᴗ˘?)", "(•﹏•)"],
  sleepy: ["(-ᴗ-)", "(ᵕᴗᵕ)", "(˘ᴗ˘)", "(-ω-)"]
};

export function resolveCompanionAvatarFrames(
  pack: CompanionPackDefinition,
  mood: CompanionMood
): string[] {
  return pack.avatarFrames?.[mood] ?? pack.avatarFrames?.idle ?? SHARED_EXPRESSION_FRAMES[mood];
}

export function listSharedExpressionFrames(): Record<CompanionMood, string[]> {
  return SHARED_EXPRESSION_FRAMES;
}
