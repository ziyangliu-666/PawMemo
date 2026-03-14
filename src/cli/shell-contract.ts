import type {
  AskWordInput,
  CaptureWordInput,
  TeachWordDraftResult,
  TeachWordInput
} from "../core/domain/models";
import type { CompanionMood } from "../companion/types";
import { ConfigurationError } from "../lib/errors";

export type ShellAction =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "pet" }
  | { kind: "stats" }
  | { kind: "rescue" }
  | { kind: "review-session" }
  | { kind: "command"; rawInput: string }
  | { kind: "ask"; input: AskWordInput }
  | { kind: "capture"; input: CaptureWordInput }
  | { kind: "teach-clarify-context"; input: TeachWordInput }
  | { kind: "teach"; input: TeachWordInput }
  | { kind: "teach-confirm"; input: TeachWordInput; draft: TeachWordDraftResult };

export interface PendingShellProposal {
  action: ShellAction;
  confirmationMessage: string;
  cancelMessage: string;
  teachDraft?: TeachWordDraftResult;
}

export type ShellAgentResponse =
  | {
      kind: "execute";
      action: ShellAction;
      source: "fast-path" | "planner";
    }
  | {
      kind: "message";
      mood: CompanionMood;
      text: string;
      source: "fast-path" | "planner";
    };

export interface ShellAgentDecision {
  response: ShellAgentResponse;
  nextPendingProposal: PendingShellProposal | null;
}

export type ShellTurnSpeaker = "user" | "assistant";

export type ShellTurnKind =
  | "utterance"
  | "message"
  | "proposal"
  | "action"
  | "result"
  | "error";

export interface ShellPlannerTurn {
  speaker: ShellTurnSpeaker;
  kind: ShellTurnKind;
  contentText: string;
  createdAt: string;
  payloadJson: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  value: unknown,
  fieldName: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`Invalid pending shell proposal: missing ${fieldName}.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTeachWordInput(value: unknown): TeachWordInput {
  if (!isRecord(value)) {
    throw new ConfigurationError("Invalid pending shell proposal: missing teach input.");
  }

  const studyContextMode =
    value.studyContextMode === "author" || value.studyContextMode === "definition"
      ? value.studyContextMode
      : undefined;

  return {
    word: readRequiredString(value.word, "action.input.word"),
    context: readRequiredString(value.context, "action.input.context"),
    sourceLabel: readOptionalString(value.sourceLabel),
    provider:
      value.provider === "gemini" ||
      value.provider === "openai" ||
      value.provider === "anthropic"
        ? value.provider
        : undefined,
    model: readOptionalString(value.model),
    apiKey: readOptionalString(value.apiKey),
    apiUrl: readOptionalString(value.apiUrl),
    studyContextMode
  };
}

function readReviewCardDrafts(value: unknown): TeachWordDraftResult["draft"]["cards"] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError("Invalid pending shell proposal: missing draft cards.");
  }

  return value.map((card, index) => {
    if (!isRecord(card)) {
      throw new ConfigurationError(
        `Invalid pending shell proposal: draft.cards[${index}] is not an object.`
      );
    }

    if (
      card.cardType !== "recognition" &&
      card.cardType !== "cloze" &&
      card.cardType !== "usage" &&
      card.cardType !== "contrast"
    ) {
      throw new ConfigurationError(
        `Invalid pending shell proposal: unsupported draft.cards[${index}].cardType.`
      );
    }

    return {
      cardType: card.cardType,
      promptText: readRequiredString(
        card.promptText,
        `draft.cards[${index}].promptText`
      ),
      answerText: readRequiredString(
        card.answerText,
        `draft.cards[${index}].answerText`
      )
    };
  });
}

function readTeachWordDraftResult(value: unknown): TeachWordDraftResult {
  if (!isRecord(value) || !isRecord(value.ask) || !isRecord(value.draft)) {
    throw new ConfigurationError("Invalid pending shell proposal: malformed teach draft.");
  }

  const ask = value.ask;
  const draft = value.draft;
  const responseLanguage =
    ask.responseLanguage === "en" || ask.responseLanguage === "zh"
      ? ask.responseLanguage
      : null;
  const promptLanguage =
    draft.promptLanguage === "en" || draft.promptLanguage === "zh"
      ? draft.promptLanguage
      : null;

  if (!responseLanguage || !promptLanguage || typeof ask.knownWord !== "boolean") {
    throw new ConfigurationError(
      "Invalid pending shell proposal: malformed teach draft metadata."
    );
  }

  return {
    ask: {
      word: readRequiredString(ask.word, "draft.ask.word"),
      normalized: readRequiredString(ask.normalized, "draft.ask.normalized"),
      gloss: readRequiredString(ask.gloss, "draft.ask.gloss"),
      explanation: readRequiredString(
        ask.explanation,
        "draft.ask.explanation"
      ),
      usageNote: readRequiredString(ask.usageNote, "draft.ask.usageNote"),
      example: readRequiredString(ask.example, "draft.ask.example"),
      highlights: Array.isArray(ask.highlights)
        ? ask.highlights.filter((item): item is string => typeof item === "string")
        : [],
      confidenceNote: readRequiredString(
        ask.confidenceNote,
        "draft.ask.confidenceNote"
      ),
      responseLanguage,
      provider:
        ask.provider === "gemini" ||
        ask.provider === "openai" ||
        ask.provider === "anthropic"
          ? ask.provider
          : "gemini",
      model: readRequiredString(ask.model, "draft.ask.model"),
      knownWord: ask.knownWord,
      knownState:
        ask.knownState === null ||
        ask.knownState === "unknown" ||
        ask.knownState === "seen" ||
        ask.knownState === "familiar" ||
        ask.knownState === "receptive" ||
        ask.knownState === "productive" ||
        ask.knownState === "stable"
          ? ask.knownState
          : null,
      retrievedGloss:
        typeof ask.retrievedGloss === "string" ? ask.retrievedGloss : null,
      recentContextCount:
        typeof ask.recentContextCount === "number" ? ask.recentContextCount : 0
    },
    draft: {
      word: readRequiredString(draft.word, "draft.word"),
      gloss: readRequiredString(draft.gloss, "draft.gloss"),
      promptLanguage,
      normalizedContext: readRequiredString(
        draft.normalizedContext,
        "draft.normalizedContext"
      ),
      clozeContext:
        draft.clozeContext === null || typeof draft.clozeContext === "string"
          ? draft.clozeContext
          : null,
      cards: readReviewCardDrafts(draft.cards)
    }
  };
}

function readPendingShellAction(value: unknown): PendingShellProposal["action"] {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new ConfigurationError("Invalid pending shell proposal: missing action.kind.");
  }

  switch (value.kind) {
    case "teach":
      return {
        kind: "teach",
        input: readTeachWordInput(value.input)
      };
    case "teach-confirm":
      return {
        kind: "teach-confirm",
        input: readTeachWordInput(value.input),
        draft: readTeachWordDraftResult(value.draft)
      };
    default:
      throw new ConfigurationError(
        `Invalid pending shell proposal: unsupported action kind ${value.kind}.`
      );
  }
}

export function serializePendingShellProposal(
  proposal: PendingShellProposal
): string {
  return JSON.stringify(proposal);
}

export function deserializePendingShellProposal(
  payloadJson: string
): PendingShellProposal {
  const parsed = JSON.parse(payloadJson) as unknown;

  if (!isRecord(parsed)) {
    throw new ConfigurationError("Invalid pending shell proposal payload.");
  }

  return {
    action: readPendingShellAction(parsed.action),
    confirmationMessage: readRequiredString(
      parsed.confirmationMessage,
      "confirmationMessage"
    ),
    cancelMessage: readRequiredString(parsed.cancelMessage, "cancelMessage"),
    teachDraft:
      parsed.teachDraft === undefined
        ? undefined
        : readTeachWordDraftResult(parsed.teachDraft)
  };
}
