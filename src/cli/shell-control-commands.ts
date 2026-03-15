import type { LlmModelInfo, LlmProviderName } from "../core/domain/models";
import { UsageError } from "../lib/errors";
import { getDefaultModelForProvider } from "../llm/provider-metadata";
import type { ListLlmModelsResult } from "../llm/llm-config-service";
import {
  formatLlmModelList,
  formatLlmStatus
} from "./format";
import type { ParsedCommand } from "./command-parser";
import type { PromptSelectionRequest } from "./review-session-runner";
import type { ShellActionExecutor } from "./shell-action-executor";
import type { ShellSessionState } from "./shell-session-state";
import type { CliDataKind } from "./theme";
import type { ShellDebugField } from "./shell-debug";
import type { ShellStreamHighlightConfig } from "./shell-surface";
import {
  asProviderName,
  parseHighlightPercent,
  parseHighlightTotalChars
} from "./shell-command-helpers";

const SHELL_HELP_TEXT = [
  "Natural input:",
  "  what does luminous mean?",
  "  save ephemeral from: The beauty was ephemeral.",
  "  remember luminous = 发光的",
  "  let's review",
  "  rescue one for me",
  "",
  "Slash commands:",
  "  /help",
  "  /pet",
  "  /capture <word> --ctx \"...\" --gloss \"...\" [--source label]",
  "  /ask <word> --ctx \"...\" [--provider PROVIDER] [--model MODEL] [--api-key KEY] [--api-url URL]",
  "  /teach <word> --ctx \"...\" [--source label] [--provider PROVIDER] [--model MODEL] [--api-key KEY] [--api-url URL]",
  "  /cards",
  "  /cards <word>",
  "  /cards create <word> <recognition|cloze|usage|contrast> --prompt \"...\" --answer \"...\"",
  "  /cards update <card-id|word[:cardType]> [--prompt \"...\"] [--answer \"...\"]",
  "  /cards pause <card-id|word[:cardType]>",
  "  /cards resume <card-id|word[:cardType]>",
  "  /cards archive <card-id|word[:cardType]>",
  "  /cards delete <card-id|word[:cardType]>",
  "  /review [session] [--limit N]",
  "  /review next",
  "  /review reveal <card-id>",
  "  /rescue",
  "  /stats",
  "  /highlight",
  "  /highlight <percent> <total-chars>",
  "  /highlight off",
  "  /models [provider]",
  "  /model",
  "  /model show",
  "  /model list [provider]",
  "  /model use <provider> [model] [--api-key KEY] [--api-url URL]",
  "  /model key <provider> <api-key>",
  "  /model url <provider> <api-url>",
  "  /quit | /exit"
].join("\n");

const MODEL_PICKER_FULL_LIST_VALUE = "__browse_all__";
const MODEL_PICKER_FULL_LIST_ALIAS = "b";
const MODEL_PICKER_DIRECT_LIST_LIMIT = 12;
const MODEL_PICKER_SHORTLIST_SIZE = 6;

type ShellModelExecutor = Pick<
  ShellActionExecutor,
  | "getLlmStatus"
  | "getCurrentLlmSettings"
  | "listModels"
  | "setProviderApiKey"
  | "setProviderApiUrl"
  | "updateCurrentLlmSettings"
>;

type ShellControlSessionState = Pick<ShellSessionState, "recordActionResult">;

export interface ShellControlCommandHost {
  executor: ShellModelExecutor;
  sessionState: ShellControlSessionState;
  writeHelp(text: string): void;
  writeAssistantReplyNow(text: string): void;
  writeDataBlock(text: string, kind?: CliDataKind): void;
  readShellSelection(request: PromptSelectionRequest): Promise<string>;
  runWithStudyWait<T>(
    label: string,
    fields: Record<string, ShellDebugField>,
    work: () => Promise<T>
  ): Promise<T>;
  setStreamHighlight(config: ShellStreamHighlightConfig | null): void;
}

export class ShellControlCommands {
  private streamHighlight: ShellStreamHighlightConfig | null = null;

  constructor(private readonly host: ShellControlCommandHost) {}

  async handle(command: ParsedCommand): Promise<boolean> {
    switch (command.name) {
      case "help":
        this.runHelp();
        return true;
      case "highlight":
        this.runHighlight(command);
        return true;
      case "model":
        await this.runModel(command);
        return true;
      case "models":
        await this.runModels(command);
        return true;
      default:
        return false;
    }
  }

  private runHelp(): void {
    this.host.writeHelp(SHELL_HELP_TEXT);
    this.host.sessionState.recordActionResult(
      SHELL_HELP_TEXT,
      JSON.stringify({ type: "help" })
    );
  }

  private runHighlight(command: ParsedCommand): void {
    const subcommand = command.args[0]?.toLowerCase();

    if (subcommand === undefined || subcommand === "show") {
      const natural = this.streamHighlight
        ? `Stream highlight is set to ${this.streamHighlight.percent}% of ${this.streamHighlight.totalChars} characters.`
        : "Stream highlight is using the default automatic window.";
      this.host.writeAssistantReplyNow(natural);
      this.host.sessionState.recordActionResult(
        natural,
        JSON.stringify({
          type: "highlight-show",
          percent: this.streamHighlight?.percent ?? null,
          totalChars: this.streamHighlight?.totalChars ?? null
        })
      );
      return;
    }

    if (subcommand === "off" || subcommand === "reset") {
      this.streamHighlight = null;
      this.host.setStreamHighlight(null);
      const natural = "Stream highlight is back on the default automatic window.";
      this.host.writeAssistantReplyNow(natural);
      this.host.sessionState.recordActionResult(
        natural,
        JSON.stringify({
          type: "highlight-reset"
        })
      );
      return;
    }

    const percent = parseHighlightPercent(command.args[0]);
    const totalChars = parseHighlightTotalChars(command.args[1] ?? command.flags.chars);

    this.streamHighlight = {
      percent,
      totalChars
    };
    this.host.setStreamHighlight(this.streamHighlight);
    const highlightChars = Math.max(1, Math.round((totalChars * percent) / 100));
    const natural = `Stream highlight now uses ${percent}% of ${totalChars} characters, so I'll accent the newest ${highlightChars} while a reply is still streaming.`;
    this.host.writeAssistantReplyNow(natural);
    this.host.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "highlight-set",
        percent,
        totalChars,
        highlightChars
      })
    );
  }

  private async runModel(command: ParsedCommand): Promise<void> {
    const subcommand = command.args[0];

    if (subcommand === undefined || subcommand === "show") {
      this.writeLlmStatus("model-status");
      return;
    }

    if (subcommand === "use" || subcommand === "set") {
      const provider = asProviderName(command.args[1]);
      const model = command.args[2];

      if (!provider) {
        throw new UsageError("`/model use` requires a provider name.");
      }

      this.host.executor.updateCurrentLlmSettings({
        provider,
        model,
        apiKey: command.flags["api-key"] ?? undefined,
        apiUrl: command.flags["api-url"] ?? undefined
      });

      this.writeLlmStatus("model-set", {
        provider,
        model: this.host.executor.getCurrentLlmSettings().model
      });
      return;
    }

    if (subcommand === "list") {
      const provider = asProviderName(command.args[1] ?? command.flags.provider);
      const result = await this.host.runWithStudyWait(
        "model list",
        {
          provider: provider ?? "active"
        },
        () =>
          this.host.executor.listModels({
            provider,
            apiKey: command.flags["api-key"],
            apiUrl: command.flags["api-url"]
          })
      );
      const formatted = formatLlmModelList(result);
      this.host.writeDataBlock(formatted, "llm-model-list");
      this.host.sessionState.recordActionResult(
        formatted,
        JSON.stringify({
          type: "model-list",
          provider: result.provider,
          count: result.models.length
        })
      );
      return;
    }

    if (subcommand === "url") {
      const provider = asProviderName(command.args[1]);
      const apiUrl = command.args[2] ?? command.flags["api-url"];

      if (!provider) {
        throw new UsageError("`/model url` requires a provider name.");
      }

      if (!apiUrl?.trim()) {
        throw new UsageError("`/model url` requires an API URL value.");
      }

      this.host.executor.setProviderApiUrl(provider, apiUrl);
      this.writeLlmStatus("model-url", { provider });
      return;
    }

    if (subcommand === "key") {
      const provider = asProviderName(command.args[1]);
      const apiKey = command.args[2];

      if (!provider) {
        throw new UsageError("`/model key` requires a provider name.");
      }

      if (!apiKey?.trim()) {
        throw new UsageError("`/model key` requires an API key value.");
      }

      this.host.executor.setProviderApiKey(provider, apiKey);
      this.writeLlmStatus("model-key", { provider });
      return;
    }

    const provider = asProviderName(subcommand);
    const modelToken = command.args[1];

    if (!provider) {
      throw new UsageError(
        [
          "`/model` expects one of:",
          "  `/model`",
          "  `/model list [provider]`",
          "  `/model use <provider> [model] [--api-key KEY] [--api-url URL]`",
          "  `/model key <provider> <api-key>`",
          "  `/model url <provider> <api-url>`"
        ].join("\n")
      );
    }

    this.host.executor.updateCurrentLlmSettings({
      provider,
      model: modelToken,
      apiKey: command.flags["api-key"] ?? undefined,
      apiUrl: command.flags["api-url"] ?? undefined
    });

    this.writeLlmStatus("model-set", {
      provider,
      model: this.host.executor.getCurrentLlmSettings().model
    });
  }

  private async runModels(command: ParsedCommand): Promise<void> {
    if (command.args.length > 1) {
      throw new UsageError("`/models` expects zero arguments or one provider name.");
    }

    const status = this.host.executor.getLlmStatus();
    const selectedProvider =
      command.args[0] !== undefined
        ? asProviderName(command.args[0])
        : ((await this.host.readShellSelection({
            promptText: "Pick a provider",
            initialValue: status.provider,
            choices: status.providers.map((provider) => ({
              value: provider.provider,
              label: provider.provider,
              aliases: [provider.provider[0] ?? provider.provider],
              description: [
                provider.selected ? "current" : "saved",
                provider.model,
                `key ${provider.apiKeyPresent ? "yes" : "no"}`,
                provider.apiUrl ? `url ${provider.apiUrl}` : null
              ]
                .filter((value) => Boolean(value))
                .join(" · ")
            }))
          })) as LlmProviderName);

    if (!selectedProvider) {
      throw new UsageError("`/models` needs a provider choice.");
    }

    const result = await this.host.runWithStudyWait(
      "model picker list",
      {
        provider: selectedProvider
      },
      () =>
        this.host.executor.listModels({
          provider: selectedProvider
        })
    );

    if (result.models.length === 0) {
      const formatted = formatLlmModelList(result);
      this.host.writeDataBlock(formatted, "llm-model-list");
      this.host.sessionState.recordActionResult(
        formatted,
        JSON.stringify({
          type: "model-picker-empty",
          provider: result.provider
        })
      );
      return;
    }

    const selectedModel = await this.readModelSelection(result);

    this.host.executor.updateCurrentLlmSettings({
      provider: selectedProvider,
      model: selectedModel
    });

    this.writeModelSwitchConfirmation({
      provider: selectedProvider,
      model: selectedModel
    });
    this.host.sessionState.recordActionResult(
      `Model switch: ${selectedProvider} (${selectedModel})`,
      JSON.stringify({
        type: "model-picker-set",
        provider: selectedProvider,
        model: selectedModel
      })
    );
  }

  private writeLlmStatus(
    actionType: string,
    payload: Record<string, string> = {}
  ): void {
    const formatted = formatLlmStatus(this.host.executor.getLlmStatus());
    this.host.writeDataBlock(formatted, "llm-status");
    this.host.sessionState.recordActionResult(
      formatted,
      JSON.stringify({
        type: actionType,
        ...payload
      })
    );
  }

  private async readModelSelection(
    result: ListLlmModelsResult
  ): Promise<string> {
    const useQuickSwitch = result.models.length > MODEL_PICKER_DIRECT_LIST_LIMIT;
    const initialRequest = useQuickSwitch
      ? this.buildQuickSwitchRequest(result)
      : this.buildFullModelListRequest(result, `Pick a ${result.provider} model`);
    const initialSelection = await this.host.readShellSelection(initialRequest);

    if (initialSelection !== MODEL_PICKER_FULL_LIST_VALUE) {
      return initialSelection;
    }

    return this.host.readShellSelection(
      this.buildFullModelListRequest(result, `Browse all ${result.provider} models`)
    );
  }

  private buildQuickSwitchRequest(
    result: ListLlmModelsResult
  ): PromptSelectionRequest {
    const shortlisted = this.shortlistModels(result);

    return {
      promptText: `Quick switch ${result.provider}`,
      initialValue: result.currentModel,
      choices: [
        ...shortlisted.map((model, index) =>
          this.toModelSelectionChoice(model, result, {
            alias: String(index + 1)
          })
        ),
        {
          value: MODEL_PICKER_FULL_LIST_VALUE,
          label: "Browse all models",
          aliases: [MODEL_PICKER_FULL_LIST_ALIAS],
          description: `show all ${result.models.length} returned models`
        }
      ]
    };
  }

  private buildFullModelListRequest(
    result: ListLlmModelsResult,
    promptText: string
  ): PromptSelectionRequest {
    return {
      promptText,
      initialValue: result.currentModel,
      choices: result.models.map((model, index) =>
        this.toModelSelectionChoice(model, result, {
          alias: String(index + 1)
        })
      )
    };
  }

  private shortlistModels(result: ListLlmModelsResult): LlmModelInfo[] {
    const defaultModel = getDefaultModelForProvider(result.provider);
    const ranked = [...result.models].sort((left, right) => {
      const scoreDelta =
        this.scoreModelForQuickSwitch(right, result.currentModel, defaultModel) -
        this.scoreModelForQuickSwitch(left, result.currentModel, defaultModel);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.id.localeCompare(right.id);
    });

    const chosen = new Map<string, LlmModelInfo>();

    const pin = (modelId: string | null | undefined) => {
      if (!modelId) {
        return;
      }

      const matched = result.models.find((model) => model.id === modelId);

      if (matched) {
        chosen.set(matched.id, matched);
      }
    };

    pin(result.currentModel);
    pin(defaultModel);

    for (const model of ranked) {
      if (chosen.size >= MODEL_PICKER_SHORTLIST_SIZE) {
        break;
      }

      chosen.set(model.id, model);
    }

    return Array.from(chosen.values()).sort((left, right) => {
      const scoreDelta =
        this.scoreModelForQuickSwitch(right, result.currentModel, defaultModel) -
        this.scoreModelForQuickSwitch(left, result.currentModel, defaultModel);

      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return left.id.localeCompare(right.id);
    });
  }

  private scoreModelForQuickSwitch(
    model: LlmModelInfo,
    currentModel: string,
    defaultModel: string
  ): number {
    let score = 0;
    const id = model.id;

    if (id === currentModel) {
      score += 1000;
    }

    if (id === defaultModel) {
      score += 800;
    }

    if (!/[\\/]/.test(id)) {
      score += 120;
    }

    if (!/(?:^|[-_/])(search|high|low|medium|max|minimal)(?:$|[-_/])/i.test(id)) {
      score += 80;
    }

    if (this.isAsciiOnly(id)) {
      score += 40;
    }

    if (/(mini|flash|sonnet)/i.test(id)) {
      score += 20;
    }

    if (/(preview|pro)/i.test(id)) {
      score += 10;
    }

    return score;
  }

  private toModelSelectionChoice(
    model: LlmModelInfo,
    result: ListLlmModelsResult,
    options: { alias: string }
  ): PromptSelectionRequest["choices"][number] {
    const defaultModel = getDefaultModelForProvider(result.provider);
    const markers = [
      model.id === result.currentModel
        ? result.provider === result.currentProvider
          ? "current"
          : "saved"
        : null,
      model.id === defaultModel ? "default" : null,
      model.displayName && model.displayName !== model.id ? model.displayName : null,
      model.ownedBy
    ].filter((value) => Boolean(value));

    return {
      value: model.id,
      label: model.id,
      aliases: [options.alias],
      description: markers.join(" · ")
    };
  }

  private writeModelSwitchConfirmation(input: {
    provider: LlmProviderName;
    model: string;
  }): void {
    this.host.writeAssistantReplyNow(
      `Switched to ${input.provider} with ${JSON.stringify(input.model)}.`
    );
  }

  private isAsciiOnly(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) > 0x7f) {
        return false;
      }
    }

    return true;
  }
}
