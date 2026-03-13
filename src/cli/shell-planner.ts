import type {
  AskWordInput,
  CaptureWordInput,
  LlmProviderName,
  TeachWordInput
} from "../core/domain/models";
import type {
  CompanionMood,
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import type { SqliteDatabase } from "../storage/sqlite/database";
import { buildShellPlannerPrompt } from "../llm/shell-planner-prompt";
import { createLlmProvider } from "../llm/provider-factory";
import { resolveApiKey } from "../llm/resolve-api-key";
import { parseStructuredJson } from "../llm/structured-output";
import type { LlmProvider } from "../llm/types";
import { ProviderRequestError } from "../lib/errors";
import type { ShellPlannerTurn } from "./shell-session-state";

export interface ShellPlannerInput {
  rawInput: string;
  recentTurns: ShellPlannerTurn[];
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  pendingProposalText?: string | null;
}

export type ShellPlannerDecision =
  | { kind: "reply"; mood: CompanionMood; message: string }
  | { kind: "clarify"; mood: CompanionMood; message: string }
  | { kind: "confirm" }
  | { kind: "cancel"; message?: string }
  | { kind: "help" }
  | { kind: "pet" }
  | { kind: "stats" }
  | { kind: "rescue" }
  | { kind: "review-session" }
  | { kind: "quit" }
  | { kind: "ask"; input: AskWordInput }
  | { kind: "teach"; input: TeachWordInput; confirmationMessage?: string }
  | { kind: "capture"; input: CaptureWordInput };

interface ShellPlannerPayload {
  kind?: unknown;
  message?: unknown;
  word?: unknown;
  context?: unknown;
  gloss?: unknown;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function fallbackContext(rawInput?: string): string | null {
  if (typeof rawInput !== "string") {
    return null;
  }

  const trimmed = rawInput.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildClarifyMessage(
  kind: "ask" | "teach" | "capture",
  payload: ShellPlannerPayload,
  rawInput?: string
): string {
  const explicitMessage = readTrimmedString(payload.message);

  if (explicitMessage) {
    return explicitMessage;
  }

  const hasFallbackContext = fallbackContext(rawInput) !== null;
  const hasWord = readTrimmedString(payload.word) !== null;
  const hasGloss = readTrimmedString(payload.gloss) !== null;

  switch (kind) {
    case "ask":
      return hasWord || hasFallbackContext
        ? "Give me the word or sentence you want explained."
        : "Point me at the word you want explained.";
    case "teach":
      return hasWord || hasFallbackContext
        ? "Tell me the word you want to add, and I can help save it."
        : "Which word do you want me to add to your study pile?";
    case "capture":
      if (!hasWord && !hasGloss) {
        return "Tell me the word and the meaning you want me to save.";
      }

      if (!hasGloss) {
        return "I caught the word, but I still need the meaning you want me to remember.";
      }

      if (!hasWord) {
        return "I caught the meaning, but I still need the word you want me to save.";
      }

      return "Give me a little more detail so I can save that cleanly.";
  }
}

function normalizeShellPlannerPayload(
  payload: ShellPlannerPayload,
  rawInput?: string
): ShellPlannerDecision {
  const kind = readTrimmedString(payload.kind)?.toLowerCase();
  const rawContext = fallbackContext(rawInput);

  switch (kind) {
    case "reply": {
      const message = readTrimmedString(payload.message);

      if (!message) {
        throw new ProviderRequestError(
          "Shell planner returned `reply` without a message."
        );
      }

      return {
        kind: "reply",
        mood: "curious",
        message
      };
    }
    case "clarify": {
      const message = readTrimmedString(payload.message);

      if (!message) {
        throw new ProviderRequestError(
          "Shell planner returned `clarify` without a message."
        );
      }

      return {
        kind: "clarify",
        mood: "confused",
        message
      };
    }
    case "confirm":
      return { kind: "confirm" };
    case "cancel":
      return {
        kind: "cancel",
        message: readTrimmedString(payload.message) ?? undefined
      };
    case "help":
      return { kind: "help" };
    case "pet":
      return { kind: "pet" };
    case "stats":
      return { kind: "stats" };
    case "rescue":
      return { kind: "rescue" };
    case "review":
    case "review-session":
      return { kind: "review-session" };
    case "quit":
    case "exit":
      return { kind: "quit" };
    case "ask": {
      const word = readTrimmedString(payload.word);
      const context = readTrimmedString(payload.context) ?? rawContext;

      if (!word || !context) {
        return {
          kind: "clarify",
          mood: "confused",
          message: buildClarifyMessage("ask", payload, rawInput)
        };
      }

      return {
        kind: "ask",
        input: { word, context }
      };
    }
    case "teach": {
      const word = readTrimmedString(payload.word);
      const context = readTrimmedString(payload.context) ?? rawContext;

      if (!word || !context) {
        return {
          kind: "clarify",
          mood: "confused",
          message: buildClarifyMessage("teach", payload, rawInput)
        };
      }

      return {
        kind: "teach",
        input: { word, context },
        confirmationMessage: readTrimmedString(payload.message) ?? undefined
      };
    }
    case "capture": {
      const word = readTrimmedString(payload.word);
      const context = readTrimmedString(payload.context) ?? rawContext;
      const gloss = readTrimmedString(payload.gloss);

      if (!word || !context || !gloss) {
        return {
          kind: "clarify",
          mood: "confused",
          message: buildClarifyMessage("capture", payload, rawInput)
        };
      }

      return {
        kind: "capture",
        input: { word, context, gloss }
      };
    }
    default: {
      const unsupportedKind =
        typeof payload.kind === "string" ? payload.kind : "undefined";
      throw new ProviderRequestError(
        `Shell planner returned unsupported kind: ${unsupportedKind}`
      );
    }
  }
}

export class LlmShellPlanner {
  private readonly settings: AppSettingsRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.settings = new AppSettingsRepository(db);
  }

  async plan(input: ShellPlannerInput): Promise<ShellPlannerDecision> {
    const llmSettings = this.settings.getLlmSettings();
    const prompt = buildShellPlannerPrompt(input);
    const apiKey = resolveApiKey(
      llmSettings.provider,
      undefined,
      llmSettings.apiKey
    );
    const provider = this.providerFactory(llmSettings.provider);
    const response = await provider.generateText({
      model: llmSettings.model,
      apiKey,
      apiUrl: llmSettings.apiUrl,
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      responseMimeType: "application/json",
      temperature: 0.1
    });
    const payload = parseStructuredJson<ShellPlannerPayload>(response.text);

    return normalizeShellPlannerPayload(payload, input.rawInput);
  }
}

export { normalizeShellPlannerPayload };
