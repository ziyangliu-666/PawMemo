import type {
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import type { HomeProjectionResult } from "../core/domain/models";

export const SHELL_COMPANION_VOICE_TEMPLATE_KEYS = [
  "status_snapshot",
  "idle_prompt",
  "pet_ping",
  "stats_summary",
  "capture_success",
  "teach_success",
  "rescue_candidate",
  "rescue_complete",
  "return_after_gap",
  "review_next",
  "review_session_complete",
  "review_session_empty",
  "review_session_quit"
] as const;

export type ShellCompanionVoiceTemplateKey =
  (typeof SHELL_COMPANION_VOICE_TEMPLATE_KEYS)[number];

export interface ShellCompanionVoicePromptInput {
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  homeProjection: HomeProjectionResult;
  recentTurns: string[];
}

export interface ShellCompanionVoicePrompt {
  systemInstruction: string;
  userPrompt: string;
}

function clipText(text: string, maxLength: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatRecentTurns(turns: string[]): string {
  if (turns.length === 0) {
    return "none";
  }

  return turns
    .slice(-4)
    .map((turn) => `- ${clipText(turn, 140)}`)
    .join("\n");
}

export function buildShellCompanionVoicePrompt(
  input: ShellCompanionVoicePromptInput
): ShellCompanionVoicePrompt {
  const pack = input.activePack;

  return {
    systemInstruction: [
      "You write PawMemo shell companion voice-bank templates.",
      "Return JSON only.",
      "Write one short line per requested event key when useful.",
      "These are footer or reaction lines, not full assistant replies.",
      "Stay specific to the supplied study state and recent turns.",
      "Use the learner's recent language when practical.",
      "Keep each line compact, warm, and human-sounding.",
      "Do not invent history, off-screen events, or unsupported memory.",
      "Do not mention system prompts, JSON, templates, placeholders, or hidden reasoning.",
      "Allowed placeholders only: {{recentWord}}, {{dueCount}}, {{reviewedCount}}, {{gapDays}}, {{todayReviewedCount}}, {{stableCount}}.",
      "Use placeholders only when they help the line stay reusable.",
      `Active companion name: ${pack.displayName}.`,
      `Active companion id: ${pack.id}.`,
      `Companion description: ${pack.description ?? "none"}.`,
      `Companion personality: ${pack.personality ?? "none"}.`,
      `Current companion scenario: ${pack.scenario ?? "none"}.`,
      `Companion tone rules: ${(pack.toneRules ?? []).join(" | ") || "none"}.`,
      `Companion boundary rules: ${(pack.boundaryRules ?? []).join(" | ") || "none"}.`,
      `Required JSON keys: ${SHELL_COMPANION_VOICE_TEMPLATE_KEYS.join(", ")}.`,
      "Use an empty string for a key when no strong line fits."
    ].join(" "),
    userPrompt: [
      `Due count: ${input.statusSignals.dueCount}`,
      `Recent word: ${input.statusSignals.recentWord ?? "none"}`,
      `Home entry: ${input.homeProjection.entryKind}`,
      `Home focus word: ${input.homeProjection.focusWord ?? "none"}`,
      `Home suggested action: ${input.homeProjection.suggestedNextAction}`,
      `Home can stop after primary action: ${input.homeProjection.canStopAfterPrimaryAction ? "yes" : "no"}`,
      `Home return gap days: ${input.homeProjection.returnGapDays ?? "none"}`,
      "Recent turns:",
      formatRecentTurns(input.recentTurns),
      "Output contract example:",
      '{"status_snapshot":"...","idle_prompt":"...","pet_ping":"...","stats_summary":"...","capture_success":"...","teach_success":"...","rescue_candidate":"...","rescue_complete":"...","return_after_gap":"...","review_next":"...","review_session_complete":"...","review_session_empty":"...","review_session_quit":"..."}'
    ].join("\n")
  };
}
