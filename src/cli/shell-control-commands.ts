import type { LlmProviderName } from "../core/domain/models";
import { UsageError } from "../lib/errors";
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

    const currentMarker =
      result.provider === result.currentProvider ? "current" : "saved";
    const selectedModel = await this.host.readShellSelection({
      promptText: `Pick a ${selectedProvider} model`,
      initialValue: result.currentModel,
      choices: result.models.map((model, index) => ({
        value: model.id,
        label: model.id,
        aliases: [String(index + 1)],
        description: [
          model.id === result.currentModel ? currentMarker : null,
          model.displayName && model.displayName !== model.id
            ? model.displayName
            : null,
          model.ownedBy
        ]
          .filter((value) => Boolean(value))
          .join(" · ")
      }))
    });

    this.host.executor.updateCurrentLlmSettings({
      provider: selectedProvider,
      model: selectedModel
    });

    this.writeLlmStatus("model-picker-set", {
      provider: selectedProvider,
      model: selectedModel
    });
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
}
