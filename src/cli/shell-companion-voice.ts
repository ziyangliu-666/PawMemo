import type {
  CompanionDynamicTemplateBank,
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import type {
  HomeProjectionResult,
  LlmSettings,
  LlmProviderName
} from "../core/domain/models";
import { createLlmProvider } from "../llm/provider-factory";
import { resolveApiKey } from "../llm/resolve-api-key";
import {
  buildShellCompanionVoicePrompt,
  SHELL_COMPANION_VOICE_TEMPLATE_KEYS,
  type ShellCompanionVoicePromptInput
} from "../llm/shell-companion-voice-prompt";
import { parseStructuredJson } from "../llm/structured-output";
import type { LlmProvider } from "../llm/types";

const MAX_DYNAMIC_TEMPLATE_LENGTH = 120;
const ALLOWED_PLACEHOLDERS = new Set([
  "recentWord",
  "dueCount",
  "reviewedCount",
  "gapDays",
  "todayReviewedCount",
  "stableCount"
]);

export interface ShellCompanionVoiceSettingsReader {
  getCurrentLlmSettings(): LlmSettings;
}

export interface ShellCompanionVoiceInput {
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
  homeProjection: HomeProjectionResult;
  recentTurns: string[];
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sanitizeDynamicTemplate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length === 0) {
    return undefined;
  }

  for (const match of normalized.matchAll(/{{\s*([a-zA-Z0-9_]+)\s*}}/g)) {
    const placeholder = match[1];

    if (!placeholder || !ALLOWED_PLACEHOLDERS.has(placeholder)) {
      return undefined;
    }
  }

  return clipText(normalized, MAX_DYNAMIC_TEMPLATE_LENGTH);
}

function normalizeVoiceBank(
  payload: Record<string, unknown>
): CompanionDynamicTemplateBank {
  const bank: CompanionDynamicTemplateBank = {};

  for (const key of SHELL_COMPANION_VOICE_TEMPLATE_KEYS) {
    const template = sanitizeDynamicTemplate(payload[key]);

    if (template) {
      bank[key] = template;
    }
  }

  return bank;
}

export class LlmShellCompanionVoiceWriter {
  constructor(
    private readonly settingsReader: ShellCompanionVoiceSettingsReader,
    private readonly providerFactory: (
      name: LlmProviderName
    ) => LlmProvider = createLlmProvider
  ) {}

  async generate(
    input: ShellCompanionVoiceInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<CompanionDynamicTemplateBank> {
    const settings = this.settingsReader.getCurrentLlmSettings();
    const apiKey = resolveApiKey(
      settings.provider,
      undefined,
      settings.apiKey
    );
    const prompt = buildShellCompanionVoicePrompt(
      input as ShellCompanionVoicePromptInput
    );
    const response = await this.providerFactory(settings.provider).generateText({
      model: settings.model,
      apiKey,
      apiUrl: settings.apiUrl,
      signal: options.signal,
      systemInstruction: prompt.systemInstruction,
      userPrompt: prompt.userPrompt,
      temperature: 0.9,
      responseMimeType: "application/json"
    });

    return parseStructuredJson(response.text, normalizeVoiceBank);
  }
}
