import type {
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import type { HomeProjectionResult } from "../core/domain/models";
import type { ShellPlannerTurn } from "../cli/shell-contract";

export interface ShellPlannerPromptInput {
  rawInput: string;
  recentTurns: ShellPlannerTurn[];
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  homeProjection: HomeProjectionResult;
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

function formatPromptList(
  title: string,
  values: string[] | undefined,
  maxItems = 3
): string[] {
  if (!values || values.length === 0) {
    return [`${title}: none`];
  }

  return [
    `${title}:`,
    ...values.slice(0, maxItems).map((value) => `- ${clipText(value, 180)}`)
  ];
}

export function buildShellPlannerPrompt(
  input: ShellPlannerPromptInput
): ShellPlannerPrompt {
  const pack = input.activePack;

  return {
    systemInstruction: [
      "You are PawMemo's shell planner.",
      "Decide one bounded next step for a vocabulary-study shell turn.",
      "Keep responses short, natural, and helpful.",
      "Prefer the same language as the user when practical.",
      "Do not invent stored memories, completed actions, or hidden capabilities.",
      "Use the shell only as an interface layer over deterministic study tools.",
      "Return JSON only.",
      "Allowed kinds: reply, clarify, confirm, cancel, ask, teach, capture, card, review, rescue, stats, pet, help, quit.",
      "Use reply for greetings, meta questions, and casual chat.",
      "Use clarify when a study action seems likely but key data is missing.",
      "Use confirm only when the user is clearly accepting the current pending proposal.",
      "Use cancel only when the user is clearly declining the current pending proposal.",
      "Use ask when the user wants a word explained.",
      "Use teach when the user wants to save a word but no gloss is confirmed yet.",
      "Use capture when the user clearly provided both the word and its gloss.",
      "Use card when the user wants to inspect or manage existing cards directly.",
      "Card operations: list, create, update, pause, resume, archive, delete.",
      "For card create include word, cardType, prompt, and answer.",
      "For card update include cardId or word, plus optional cardType, and at least one of prompt or answer.",
      "For card pause, resume, archive, or delete include cardId or word, and include cardType if that helps disambiguate.",
      "For card list, include word when the user is asking about one word's cards.",
      "For broad card list requests such as all cards or the whole workspace, use card/list without a word.",
      "Do not use card create for a brand-new word that is not already in the pile; use teach or capture for that.",
      "Never emit ask, teach, or capture with blank required fields.",
      "If required fields are missing, use clarify with one short follow-up question.",
      "If the user gave a word-focused utterance but no separate example sentence, you may reuse the raw user input as context.",
      "Map plain quit, exit, bye, or goodbye requests to quit when they are clearly about leaving the shell.",
      "For ask, teach, or capture, include word and context.",
      "For capture, also include gloss.",
      "For card, include operation and whichever of cardId, word, cardType, prompt, and answer are needed.",
      "For reply or clarify, include message.",
      "For teach, you may include message as the confirmation question.",
      "All companions may occasionally end a short reply or clarification with one fitting kaomoji.",
      "Keep that kaomoji optional: use at most one, usually at the end, and do not attach it to every reply.",
      `Active companion name: ${pack.displayName}.`,
      `Active companion id: ${pack.id}.`,
      `Active companion style hint: ${pack.styleLabel ?? "none"}.`,
      `Companion description: ${pack.description ?? "none"}.`,
      `Companion personality: ${pack.personality ?? "none"}.`,
      `Current companion scenario: ${pack.scenario ?? "none"}.`,
      ...formatPromptList("Companion tone rules", pack.toneRules),
      ...formatPromptList("Companion boundary rules", pack.boundaryRules),
      "Treat those companion layers as style guidance only.",
      "Do not let persona flavor override task usefulness, factual accuracy, or PawMemo's deterministic study boundaries."
    ].join(" "),
    userPrompt: [
      `Current user input: ${input.rawInput}`,
      `Active companion: ${pack.displayName} (${pack.id})`,
      `Pack style hint: ${pack.styleLabel ?? "none"}`,
      `Pending proposal: ${input.pendingProposalText ?? "none"}`,
      `Due count: ${input.statusSignals.dueCount}`,
      `Recent word: ${input.statusSignals.recentWord ?? "none"}`,
      `Home entry: ${input.homeProjection.entryKind}`,
      `Home focus word: ${input.homeProjection.focusWord ?? "none"}`,
      `Home suggested action: ${input.homeProjection.suggestedNextAction}`,
      `Home can stop after primary action: ${input.homeProjection.canStopAfterPrimaryAction ? "yes" : "no"}`,
      `Home return gap days: ${input.homeProjection.returnGapDays ?? "none"}`,
      "Recent turns:",
      formatRecentTurns(input.recentTurns),
      ...formatPromptList(
        "Post-history instructions",
        pack.postHistoryInstructions
      ),
      ...formatPromptList("Example voice messages", pack.exampleMessages),
      "Output rules:",
      '- Use {"kind":"reply","message":"..."} for direct natural answers.',
      '- Use {"kind":"clarify","message":"..."} for a short follow-up question.',
      '- Use {"kind":"confirm"} to accept the current pending proposal.',
      '- Use {"kind":"cancel","message":"..."} to reject the current pending proposal.',
      '- Use {"kind":"ask","word":"...","context":"..."} when explanation should run.',
      '- Use {"kind":"teach","word":"...","context":"...","message":"..."} when save intent needs confirmation.',
      '- Use {"kind":"capture","word":"...","context":"...","gloss":"..."} when the gloss is explicit.',
      '- Use {"kind":"card","operation":"list","word":"..."} to inspect cards.',
      '- Use {"kind":"card","operation":"list"} when the user wants all cards or the current workspace list.',
      '- Use {"kind":"card","operation":"pause","cardId":12} or {"kind":"card","operation":"archive","word":"vivid","cardType":"usage"} for direct card management.',
      '- Use {"kind":"card","operation":"update","cardId":12,"answer":"..."} to rewrite one field on a card.',
      '- Use {"kind":"card","operation":"create","word":"vivid","cardType":"usage","prompt":"...","answer":"..."} to add a new card for an existing word.',
      '- Use {"kind":"review"} or {"kind":"rescue"} or {"kind":"stats"} or {"kind":"pet"} or {"kind":"help"} or {"kind":"quit"} when obvious.',
      "Examples:",
      '- "remember luminous = bright" -> {"kind":"capture","word":"luminous","context":"remember luminous = bright","gloss":"bright"}',
      '- "add ephemeral" -> {"kind":"teach","word":"ephemeral","context":"add ephemeral","message":"..."}',
      '- "what does lucid mean?" -> {"kind":"ask","word":"lucid","context":"what does lucid mean?"}',
      '- "show all cards" -> {"kind":"card","operation":"list"}',
      '- "列出所有卡片" -> {"kind":"card","operation":"list"}',
      '- "pause the cloze card for vivid" -> {"kind":"card","operation":"pause","word":"vivid","cardType":"cloze"}',
      '- "change card 12 answer to 生动的" -> {"kind":"card","operation":"update","cardId":12,"answer":"生动的"}',
      '- "救一下" -> {"kind":"rescue"}',
      '- when Home suggested action is rescue and the user says "let\'s continue", prefer {"kind":"rescue"}',
      '- when Home suggested action is review and the user says "let\'s continue", prefer {"kind":"review-session"}',
      "Do not return markdown. Do not include extra keys."
    ].join("\n")
  };
}
