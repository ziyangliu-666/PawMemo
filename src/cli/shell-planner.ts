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

export interface ShellPlannerStreamCallbacks {
  onMessageDelta: (delta: string) => void | Promise<void>;
}

export interface ShellPlannerRunOptions {
  onMessageDelta?: (delta: string) => void | Promise<void>;
  signal?: AbortSignal;
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

interface ParsedJsonString {
  value: string;
  nextIndex: number;
  complete: boolean;
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

  let cursor = index;

  while (cursor < input.length) {
    const valueChar = input[cursor] ?? "";

    if (valueChar === "," || valueChar === "}") {
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
  let depth = 0;

  while (index < input.length) {
    const char = input[index] ?? "";

    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === "}") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    if (depth !== 1) {
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
  private readonly settings: AppSettingsRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.settings = new AppSettingsRepository(db);
  }

  async plan(
    input: ShellPlannerInput,
    options: ShellPlannerRunOptions = {}
  ): Promise<ShellPlannerDecision> {
    const llmSettings = this.settings.getLlmSettings();
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
    const payload = parseStructuredJson<ShellPlannerPayload>(response.text);

    return normalizeShellPlannerPayload(payload, input.rawInput);
  }
}

export { normalizeShellPlannerPayload };
