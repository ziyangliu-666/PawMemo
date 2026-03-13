import type {
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import type { ShellPlannerTurn } from "../cli/shell-session-state";

export interface ShellPlannerPromptInput {
  rawInput: string;
  recentTurns: ShellPlannerTurn[];
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  pendingProposalText?: string | null;
}

export interface ShellPlannerPrompt {
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

function formatRecentTurns(turns: ShellPlannerTurn[]): string {
  if (turns.length === 0) {
    return "none";
  }

  return turns
    .slice(-4)
    .map((turn) => `${turn.speaker}/${turn.kind}: ${clipText(turn.contentText, 140)}`)
    .join("\n");
}

export function buildShellPlannerPrompt(
  input: ShellPlannerPromptInput
): ShellPlannerPrompt {
  return {
    systemInstruction: [
      "You are PawMemo's shell planner.",
      "Decide one bounded next step for a vocabulary-study shell turn.",
      "Keep responses short, natural, and helpful.",
      "Prefer the same language as the user when practical.",
      "Do not invent stored memories, completed actions, or hidden capabilities.",
      "Use the shell only as an interface layer over deterministic study tools.",
      "Return JSON only.",
      "Allowed kinds: reply, clarify, confirm, cancel, ask, teach, capture, review, rescue, stats, pet, help, quit.",
      "Use reply for greetings, meta questions, and casual chat.",
      "Use clarify when a study action seems likely but key data is missing.",
      "Use confirm only when the user is clearly accepting the current pending proposal.",
      "Use cancel only when the user is clearly declining the current pending proposal.",
      "Use ask when the user wants a word explained.",
      "Use teach when the user wants to save a word but no gloss is confirmed yet.",
      "Use capture when the user clearly provided both the word and its gloss.",
      "Never emit ask, teach, or capture with blank required fields.",
      "If required fields are missing, use clarify with one short follow-up question.",
      "If the user gave a word-focused utterance but no separate example sentence, you may reuse the raw user input as context.",
      "Map plain quit, exit, bye, or goodbye requests to quit when they are clearly about leaving the shell.",
      "For ask, teach, or capture, include word and context.",
      "For capture, also include gloss.",
      "For reply or clarify, include message.",
      "For teach, you may include message as the confirmation question."
    ].join(" "),
    userPrompt: [
      `Current user input: ${input.rawInput}`,
      `Active companion: ${input.activePack.displayName} (${input.activePack.id})`,
      `Pack style hint: ${input.activePack.styleLabel ?? "none"}`,
      `Pending proposal: ${input.pendingProposalText ?? "none"}`,
      `Due count: ${input.statusSignals.dueCount}`,
      `Recent word: ${input.statusSignals.recentWord ?? "none"}`,
      "Recent turns:",
      formatRecentTurns(input.recentTurns),
      "Output rules:",
      '- Use {"kind":"reply","message":"..."} for direct natural answers.',
      '- Use {"kind":"clarify","message":"..."} for a short follow-up question.',
      '- Use {"kind":"confirm"} to accept the current pending proposal.',
      '- Use {"kind":"cancel","message":"..."} to reject the current pending proposal.',
      '- Use {"kind":"ask","word":"...","context":"..."} when explanation should run.',
      '- Use {"kind":"teach","word":"...","context":"...","message":"..."} when save intent needs confirmation.',
      '- Use {"kind":"capture","word":"...","context":"...","gloss":"..."} when the gloss is explicit.',
      '- Use {"kind":"review"} or {"kind":"rescue"} or {"kind":"stats"} or {"kind":"pet"} or {"kind":"help"} or {"kind":"quit"} when obvious.',
      "Examples:",
      '- "remember luminous = bright" -> {"kind":"capture","word":"luminous","context":"remember luminous = bright","gloss":"bright"}',
      '- "add ephemeral" -> {"kind":"teach","word":"ephemeral","context":"add ephemeral","message":"..."}',
      '- "what does lucid mean?" -> {"kind":"ask","word":"lucid","context":"what does lucid mean?"}',
      '- "救一下" -> {"kind":"rescue"}',
      "Do not return markdown. Do not include extra keys."
    ].join("\n")
  };
}
