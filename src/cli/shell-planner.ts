import type {
  AskWordInput,
  CaptureWordInput,
  CreateStudyCardInput,
  HomeProjectionResult,
  LlmSettings,
  LlmProviderName,
  ReviewCardType,
  SetStudyCardLifecycleInput,
  StudyCardSelector,
  TeachWordInput,
  UpdateStudyCardInput
} from "../core/domain/models";
import type {
  CompanionMood,
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import { buildShellPlannerPrompt } from "../llm/shell-planner-prompt";
import { createLlmProvider } from "../llm/provider-factory";
import { resolveApiKey } from "../llm/resolve-api-key";
import { parseStructuredJson } from "../llm/structured-output";
import type { LlmProvider } from "../llm/types";
import { ProviderRequestError } from "../lib/errors";
import type { ShellPlannerTurn } from "./shell-contract";

export interface ShellPlannerInput {
  rawInput: string;
  recentTurns: ShellPlannerTurn[];
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  homeProjection: HomeProjectionResult;
  pendingProposalText?: string | null;
}

export interface ShellPlannerStreamCallbacks {
  onMessageDelta: (delta: string) => void | Promise<void>;
}

export interface ShellPlannerRunOptions {
  onMessageDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ShellPlannerSettingsReader {
  getCurrentLlmSettings(): LlmSettings;
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
  | { kind: "capture"; input: CaptureWordInput }
  | {
      kind: "card-list";
      input: {
        word?: string;
        cardType?: ReviewCardType;
      };
    }
  | { kind: "card-create"; input: CreateStudyCardInput }
  | { kind: "card-update"; input: UpdateStudyCardInput }
  | { kind: "card-set-lifecycle"; input: SetStudyCardLifecycleInput }
  | { kind: "card-delete"; input: { selector: StudyCardSelector } };

interface ShellPlannerPayload {
  kind?: unknown;
  message?: unknown;
  operation?: unknown;
  cardId?: unknown;
  word?: unknown;
  cardType?: unknown;
  context?: unknown;
  gloss?: unknown;
  prompt?: unknown;
  answer?: unknown;
}

interface ParsedJsonString {
  value: string;
  nextIndex: number;
  complete: boolean;
}

function toShellPlannerPayload(
  payload: Record<string, unknown>
): ShellPlannerPayload {
  return {
    kind: payload.kind,
    message: payload.message,
    operation: payload.operation,
    cardId: payload.cardId,
    word: payload.word,
    cardType: payload.cardType,
    context: payload.context,
    gloss: payload.gloss,
    prompt: payload.prompt,
    answer: payload.answer
  };
}

function readCardType(value: unknown): ReviewCardType | null {
  return value === "recognition" ||
    value === "cloze" ||
    value === "usage" ||
    value === "contrast"
    ? value
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function buildStudyCardSelector(
  payload: ShellPlannerPayload
): StudyCardSelector | null {
  const cardId = readPositiveInteger(payload.cardId);
  const word = readTrimmedString(payload.word) ?? undefined;
  const cardType = readCardType(payload.cardType) ?? undefined;

  if (cardId === null && !word) {
    return null;
  }

  return {
    ...(cardId !== null ? { cardId } : {}),
    ...(word ? { word } : {}),
    ...(cardType ? { cardType } : {})
  };
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
  kind: "ask" | "teach" | "capture" | "card",
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
  const hasCardId = readPositiveInteger(payload.cardId) !== null;
  const operation = readTrimmedString(payload.operation)?.toLowerCase();

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
    case "card":
      if (operation === "create") {
        return "Tell me the word, card type, prompt, and answer you want for that new card.";
      }

      if (operation === "update") {
        return "Tell me which card to change, then give me the new prompt, the new answer, or both.";
      }

      if (operation === "list") {
        return "Tell me which word's cards you want to inspect.";
      }

      if (!hasCardId && !hasWord) {
        return "Tell me which card you mean with a card id or a word.";
      }

      return "Tell me a little more so I can manage the right card.";
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
    case "card": {
      const operation = readTrimmedString(payload.operation)?.toLowerCase();

      if (!operation) {
        return {
          kind: "clarify",
          mood: "confused",
          message: buildClarifyMessage("card", payload, rawInput)
        };
      }

      switch (operation) {
        case "list": {
          const word = readTrimmedString(payload.word) ?? undefined;
          const cardType = readCardType(payload.cardType) ?? undefined;

          return {
            kind: "card-list",
            input: {
              ...(word ? { word } : {}),
              ...(cardType ? { cardType } : {})
            }
          };
        }
        case "create": {
          const word = readTrimmedString(payload.word);
          const cardType = readCardType(payload.cardType);
          const prompt = readTrimmedString(payload.prompt);
          const answer = readTrimmedString(payload.answer);

          if (!word || !cardType || !prompt || !answer) {
            return {
              kind: "clarify",
              mood: "confused",
              message: buildClarifyMessage("card", payload, rawInput)
            };
          }

          return {
            kind: "card-create",
            input: {
              word,
              cardType,
              promptText: prompt,
              answerText: answer
            }
          };
        }
        case "update": {
          const selector = buildStudyCardSelector(payload);
          const prompt = readTrimmedString(payload.prompt) ?? undefined;
          const answer = readTrimmedString(payload.answer) ?? undefined;

          if (!selector || (!prompt && !answer)) {
            return {
              kind: "clarify",
              mood: "confused",
              message: buildClarifyMessage("card", payload, rawInput)
            };
          }

          return {
            kind: "card-update",
            input: {
              selector,
              ...(prompt ? { promptText: prompt } : {}),
              ...(answer ? { answerText: answer } : {})
            }
          };
        }
        case "pause":
        case "resume":
        case "archive": {
          const selector = buildStudyCardSelector(payload);

          if (!selector) {
            return {
              kind: "clarify",
              mood: "confused",
              message: buildClarifyMessage("card", payload, rawInput)
            };
          }

          return {
            kind: "card-set-lifecycle",
            input: {
              selector,
              lifecycleState:
                operation === "pause"
                  ? "paused"
                  : operation === "archive"
                    ? "archived"
                    : "active"
            }
          };
        }
        case "delete": {
          const selector = buildStudyCardSelector(payload);

          if (!selector) {
            return {
              kind: "clarify",
              mood: "confused",
              message: buildClarifyMessage("card", payload, rawInput)
            };
          }

          return {
            kind: "card-delete",
            input: {
              selector
            }
          };
        }
        default:
          throw new ProviderRequestError(
            `Shell planner returned unsupported card operation: ${operation}`
          );
      }
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

function parseJsonStringAt(input: string, startIndex: number): ParsedJsonString | null {
  if (input[startIndex] !== "\"") {
    return null;
  }

  let index = startIndex + 1;
  let value = "";
  let pendingUnicode: string | null = null;
  let escape = false;

  while (index < input.length) {
    const char = input[index] ?? "";

    if (pendingUnicode !== null) {
      pendingUnicode += char;

      if (pendingUnicode.length === 4) {
        const codePoint = Number.parseInt(pendingUnicode, 16);
        value += Number.isNaN(codePoint) ? "" : String.fromCharCode(codePoint);
        pendingUnicode = null;
      }

      index += 1;
      continue;
    }

    if (escape) {
      switch (char) {
        case "\"":
        case "\\":
        case "/":
          value += char;
          break;
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "u":
          pendingUnicode = "";
          break;
        default:
          value += char;
          break;
      }

      escape = false;
      index += 1;
      continue;
    }

    if (char === "\\") {
      escape = true;
      index += 1;
      continue;
    }

    if (char === "\"") {
      return {
        value,
        nextIndex: index + 1,
        complete: true
      };
    }

    value += char;
    index += 1;
  }

  return {
    value,
    nextIndex: input.length,
    complete: false
  };
}

function skipWhitespace(input: string, startIndex: number): number {
  let index = startIndex;

  while (index < input.length && /\s/.test(input[index] ?? "")) {
    index += 1;
  }

  return index;
}

function skipJsonValue(input: string, startIndex: number): number {
  const index = skipWhitespace(input, startIndex);
  const char = input[index];

  if (char === "\"") {
    const parsed = parseJsonStringAt(input, index);
    return parsed?.nextIndex ?? input.length;
  }

  if (char === "{" || char === "[") {
    const stack: string[] = [char === "{" ? "}" : "]"];
    let cursor = index + 1;
    let escape = false;
    let inString = false;

    while (cursor < input.length) {
      const valueChar = input[cursor] ?? "";

      if (inString) {
        if (escape) {
          escape = false;
        } else if (valueChar === "\\") {
          escape = true;
        } else if (valueChar === "\"") {
          inString = false;
        }

        cursor += 1;
        continue;
      }

      if (valueChar === "\"") {
        inString = true;
        cursor += 1;
        continue;
      }

      if (valueChar === "{") {
        stack.push("}");
        cursor += 1;
        continue;
      }

      if (valueChar === "[") {
        stack.push("]");
        cursor += 1;
        continue;
      }

      if (valueChar === "}" || valueChar === "]") {
        const expected = stack.pop();

        if (expected !== valueChar) {
          return cursor;
        }

        cursor += 1;

        if (stack.length === 0) {
          return cursor;
        }

        continue;
      }

      cursor += 1;
    }

    return cursor;
  }

  let cursor = index;

  while (cursor < input.length) {
    const valueChar = input[cursor] ?? "";

    if (valueChar === "," || valueChar === "}" || valueChar === "]") {
      return cursor;
    }

    cursor += 1;
  }

  return cursor;
}

function readTopLevelStringFieldPrefix(
  input: string,
  targetKey: string
): ParsedJsonString | null {
  let index = 0;
  const stack: string[] = [];

  while (index < input.length) {
    const char = input[index] ?? "";

    if (char === "{") {
      stack.push("}");
      index += 1;
      continue;
    }

    if (char === "[") {
      stack.push("]");
      index += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.length > 0) {
        stack.pop();
      }
      index += 1;
      continue;
    }

    if (!(stack.length === 1 && stack[0] === "}")) {
      index += 1;
      continue;
    }

    if (char === "," || /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char !== "\"") {
      index += 1;
      continue;
    }

    const key = parseJsonStringAt(input, index);

    if (!key || !key.complete) {
      return null;
    }

    index = skipWhitespace(input, key.nextIndex);

    if (input[index] !== ":") {
      continue;
    }

    index = skipWhitespace(input, index + 1);

    if (key.value === targetKey) {
      return input[index] === "\""
        ? parseJsonStringAt(input, index)
        : null;
    }

    index = skipJsonValue(input, index);
  }

  return null;
}

class ShellPlannerMessageStreamer {
  private buffer = "";
  private emittedLength = 0;
  private streamable: boolean | null = null;

  constructor(
    private readonly callbacks: ShellPlannerStreamCallbacks
  ) {}

  async push(delta: string): Promise<void> {
    this.buffer += delta;

    const kindField = readTopLevelStringFieldPrefix(this.buffer, "kind");

    if (kindField?.complete) {
      this.streamable =
        kindField.value === "reply" || kindField.value === "clarify";
    }

    if (this.streamable !== true) {
      return;
    }

    const messageField = readTopLevelStringFieldPrefix(this.buffer, "message");

    if (!messageField) {
      return;
    }

    const nextDelta = messageField.value.slice(this.emittedLength);

    if (nextDelta.length === 0) {
      return;
    }

    this.emittedLength = messageField.value.length;
    await this.callbacks.onMessageDelta(nextDelta);
  }
}

export class LlmShellPlanner {
  constructor(
    private readonly settings: ShellPlannerSettingsReader,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {}

  async plan(
    input: ShellPlannerInput,
    options: ShellPlannerRunOptions = {}
  ): Promise<ShellPlannerDecision> {
    const llmSettings = this.settings.getCurrentLlmSettings();
    const prompt = buildShellPlannerPrompt(input);
    const apiKey = resolveApiKey(
      llmSettings.provider,
      undefined,
      llmSettings.apiKey
    );
    const provider = this.providerFactory(llmSettings.provider);
    const request = {
      model: llmSettings.model,
      apiKey,
      apiUrl: llmSettings.apiUrl,
      signal: options.signal,
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      responseMimeType: "application/json",
      temperature: 0.1
    };
    const streamer = options.onMessageDelta
      ? new ShellPlannerMessageStreamer({
          onMessageDelta: options.onMessageDelta
        })
      : null;
    const response =
      streamer && provider.generateTextStream
        ? await provider.generateTextStream({
            ...request,
            onTextDelta: async (delta) => {
              await streamer.push(delta);
            }
          })
        : await provider.generateText(request);
    const payload = parseStructuredJson(response.text, toShellPlannerPayload);

    return normalizeShellPlannerPayload(payload, input.rawInput);
  }
}

export { normalizeShellPlannerPayload };
