import { performance } from "node:perf_hooks";
import {
  loadCompanionPack,
} from "../companion/packs";
import {
  renderCompanionPresenceLine
} from "../companion/presenter";
import { buildCompanionReaction } from "../companion/reaction-builder";
import type {
  CompanionMood,
  CompanionEvent,
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import type {
  AskWordInput,
  CaptureWordInput,
  LlmProviderName,
  TeachWordDraftResult,
  TeachWordInput
} from "../core/domain/models";
import { detectCardPromptLanguage } from "../review/card-language";
import { isLlmProviderName } from "../llm/provider-factory";
import type { LlmProvider } from "../llm/types";
import {
  ConfigurationError,
  CardAuthorContractError,
  DuplicateEncounterError,
  ExplanationContractError,
  NotFoundError,
  ProviderRequestError,
  ReviewCardNotDueError,
  UsageError
} from "../lib/errors";
import type { SqliteDatabase } from "../storage/sqlite/database";
import {
  formatLlmModelList,
  formatLlmStatus,
  formatNextReviewCard,
  formatReviewReveal
} from "./format";
import {
  formatPromptSelectionPrompt,
  resolvePromptSelection,
  type PromptSelectionRequest
} from "./review-session-runner";
import {
  createShellReviewSessionCopy,
  presentShellAskResult,
  presentShellCaptureResult,
  presentShellError,
  presentShellNoRescueCandidate,
  presentShellRescueIntro,
  presentShellReviewIntro,
  presentShellReviewSessionSummary,
  presentShellStatsResult,
  presentShellTeachResult
} from "./shell-presenter";
import { buildReviewSessionCompanionEvent } from "./review-session-feedback";
import {
  ShellConversationAgent,
  type ShellAction,
  type ShellAgentDecision,
  type ShellAgentResponse
} from "./shell-agent";
import { LlmShellPlanner } from "./shell-planner";
import type { CliDataKind } from "./theme";
import { parseCommand, tokenizeCommandLine } from "./command-parser";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import {
  LineShellSurface,
  ReadlineShellTerminal,
  type ShellStreamHighlightConfig,
  type ShellSurface,
  type ShellTerminal
} from "./shell-surface";
import { ShellSessionState } from "./shell-session-state";
import { ShellActionExecutor } from "./shell-action-executor";
import {
  createAskResultIntent,
  createTeachDraftCancelMessage,
  createTeachDraftConfirmationMessage,
  createTeachDraftIntent,
  flattenStudyCardIntent
} from "./study-card-view";

export interface ShellRunnerOptions {
  db: SqliteDatabase;
  providerFactory?: (name: LlmProviderName) => LlmProvider;
  terminal?: ShellTerminal;
  surface?: ShellSurface;
  packId?: string;
  debug?: boolean;
}

interface ShellState {
  mood: CompanionMood;
  frame: number;
  lineOverride?: string;
}

type ShellDebugField = string | number | boolean | null | undefined;

const SHELL_WAIT_DELAY_MS = 180;

function parsePositiveId(rawValue: string | undefined, message: string): number {
  const value = Number.parseInt(rawValue ?? "", 10);

  if (Number.isNaN(value) || value <= 0) {
    throw new UsageError(message);
  }

  return value;
}

function parseOptionalLimit(rawValue: string | undefined): number | undefined {
  if (rawValue === undefined) {
    return undefined;
  }

  const limit = Number.parseInt(rawValue, 10);

  if (Number.isNaN(limit) || limit < 0) {
    throw new UsageError("`review` requires --limit to be zero or greater.");
  }

  return limit;
}

function asProviderName(value: string | undefined): LlmProviderName | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isLlmProviderName(value)) {
    throw new UsageError(`Unsupported provider: ${value}`);
  }

  return value;
}

function formatPerfMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  if (value >= 100) {
    return `${value.toFixed(0)}ms`;
  }

  return `${value.toFixed(1)}ms`;
}

function buildTeachDraftSelectionRequest(
  draft: TeachWordDraftResult
): PromptSelectionRequest {
  const language = draft.draft.promptLanguage;
  const cardCount = draft.draft.cards.length;

  if (language === "zh") {
    return {
      promptText: `要按这个保存 “${draft.ask.word}” 吗？`,
      initialValue: "confirm",
      choices: [
        {
          value: "confirm",
          label: `加入这 ${cardCount} 张卡`,
          aliases: ["1", "y", "yes", "s"],
          description: "按这个草稿写入学习计划"
        },
        {
          value: "cancel",
          label: "先不保存",
          aliases: ["2", "n", "no", "q"],
          description: "先留在预览，不写入"
        }
      ]
    };
  }

  return {
    promptText: `Save this draft for "${draft.ask.word}"?`,
    initialValue: "confirm",
    choices: [
      {
        value: "confirm",
        label: `Save ${cardCount} card${cardCount === 1 ? "" : "s"}`,
        aliases: ["1", "y", "yes", "s"],
        description: "Persist this exact draft into the study plan"
      },
      {
        value: "cancel",
        label: "Not now",
        aliases: ["2", "n", "no", "q"],
        description: "Leave it as a preview without saving"
      }
    ]
  };
}

function parseHighlightPercent(rawValue: string | undefined): number {
  const value = Number.parseFloat(rawValue ?? "");

  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new UsageError("`/highlight` requires a percent between 0 and 100.");
  }

  return value;
}

function parseHighlightTotalChars(rawValue: string | undefined): number {
  const value = Number.parseInt(rawValue ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError("`/highlight` requires a positive total character count.");
  }

  return value;
}

export class ShellRunner {
  private readonly surface: ShellSurface;
  private readonly conversationAgent: ShellConversationAgent;
  private readonly sessionState = new ShellSessionState();
  private readonly executor: ShellActionExecutor;
  private readonly activePack: CompanionPackDefinition;
  private readonly debugEnabled: boolean;
  private streamHighlight: ShellStreamHighlightConfig | null = null;
  private readonly shellState: ShellState = {
    mood: "idle",
    frame: 0
  };
  private plannerMessageStreamStarted = false;

  constructor(options: ShellRunnerOptions) {
    const terminal = options.terminal ?? new ReadlineShellTerminal();
    this.surface = options.surface ?? new LineShellSurface(terminal);
    this.executor = new ShellActionExecutor(options.db, options.providerFactory);
    this.debugEnabled = options.debug ?? false;
    const settings = new AppSettingsRepository(options.db);
    this.activePack = loadCompanionPack(
      options.packId ?? settings.getCompanionPackId()
    );
    this.conversationAgent = new ShellConversationAgent(
      new LlmShellPlanner(options.db, options.providerFactory)
    );
  }

  async run(): Promise<void> {
    this.surface.beginShell(this.activePack.displayName);
    this.writeDebug("shell start", {
      pack: this.activePack.id,
      surface: this.surface.constructor.name,
      debug: this.debugEnabled
    });

    try {
      while (true) {
        this.renderCompanion();
        const rawInput = (
          await this.surface.prompt()
        ).trim();

        if (rawInput.length === 0) {
          this.applyReaction({ type: "idle_prompt" });
          continue;
        }

        const turnStartedAt = performance.now();
        let turnOutcome = "ok";
        let shouldExit = false;

        try {
          this.sessionState.recordUserUtterance(rawInput);
          this.resetPlannerMessageStream();
          const decision = await this.withMeasuredStage(
            "planner",
            {
              pending: this.sessionState.getPendingProposal()?.action.kind ?? "none",
              inputLength: rawInput.length
            },
            () =>
              this.conversationAgent.respond(rawInput, {
                pendingProposal: this.sessionState.getPendingProposal(),
                context: {
                  recentTurns: this.sessionState.listRecentTurns(6),
                  activePack: this.activePack,
                  statusSignals: this.getStatusSignals()
                },
                onPlannerMessageDelta: (delta) => {
                  this.onPlannerMessageDelta(delta);
                }
              }),
              { type: "planner_wait" },
              () => this.plannerMessageStreamStarted
            );
          const preparedDecision = await this.prepareDecision(decision);
          this.writeDebug(
            "agent response",
            this.describeAgentResponse(preparedDecision.response)
          );
          this.writeDebug("pending proposal", {
            next: preparedDecision.nextPendingProposal?.action.kind ?? "none"
          });
          this.sessionState.applyDecision(preparedDecision);
          shouldExit = await this.withMeasuredStage(
            "response",
            {
              kind: preparedDecision.response.kind,
              action:
                preparedDecision.response.kind === "execute"
                  ? preparedDecision.response.action.kind
                  : "message"
            },
            () => this.handleDecision(preparedDecision)
          );

          if (shouldExit) {
            return;
          }
        } catch (error) {
          turnOutcome = "error";
          this.resetPlannerMessageStream(false);
          this.applyReaction({
            type: "command_error",
            errorMessage:
              error instanceof UsageError
                ? undefined
                : error instanceof Error
                  ? error.message
                  : undefined
          });
          this.writeShellError(error);
        } finally {
          this.writePerf("turn", performance.now() - turnStartedAt, {
            outcome: turnOutcome,
            exit: shouldExit,
            inputLength: rawInput.length
          });
        }
      }
    } finally {
      await this.surface.close();
    }
  }

  private async handleDecision(
    decision: ShellAgentDecision
  ): Promise<boolean> {
    const streamedPlannerMessage = this.plannerMessageStreamStarted;
    if (streamedPlannerMessage) {
      this.resetPlannerMessageStream(true);
    }

    if (
      decision.response.kind === "message" &&
      decision.nextPendingProposal?.teachDraft
    ) {
      this.shellState.mood = decision.response.mood;
      await this.writeAssistantReply(decision.response.text);
      const draftIntent = createTeachDraftIntent(decision.nextPendingProposal.teachDraft);
      this.surface.writeDataBlock(
        flattenStudyCardIntent(draftIntent),
        "plain",
        draftIntent
      );
      const selection = await this.readShellSelection(
        buildTeachDraftSelectionRequest(decision.nextPendingProposal.teachDraft)
      );
      const followUpDecision: ShellAgentDecision =
        selection === "confirm"
          ? {
              response: {
                kind: "execute",
                action: decision.nextPendingProposal.action,
                source: "fast-path"
              },
              nextPendingProposal: null
            }
          : {
              response: {
                kind: "message",
                mood: "idle",
                text: decision.nextPendingProposal.cancelMessage,
                source: "fast-path"
              },
              nextPendingProposal: null
            };
      this.sessionState.applyDecision(followUpDecision);
      return this.handleDecision(followUpDecision);
    }

    if (streamedPlannerMessage && decision.response.kind === "message") {
      this.shellState.mood = decision.response.mood;
      return false;
    }

    return this.handleAgentResponse(decision.response);
  }

  private async handleAgentResponse(
    response: ShellAgentResponse
  ): Promise<boolean> {
    switch (response.kind) {
      case "message":
        this.shellState.mood = response.mood;
        await this.writeAssistantReply(response.text);
        return false;
      case "execute":
        return this.executeAction(response.action);
      default:
        return false;
    }
  }

  private async prepareDecision(
    decision: ShellAgentDecision
  ): Promise<ShellAgentDecision> {
    if (decision.nextPendingProposal?.action.kind !== "teach") {
      return decision;
    }

    const input = decision.nextPendingProposal.action.input;
    try {
      const teachDraft = await this.withMeasuredStage(
        "teach draft",
        { word: input.word },
        () =>
          this.executor.draftTeach(input, (event) => {
            this.writePerf(
              `teach ${event.stage.replace(/_/g, " ")}`,
              event.elapsedMs,
              { word: input.word }
            );
          }),
        { type: "study_wait" }
      );

      return this.buildTeachDraftDecision(input, teachDraft, decision.response.source);
    } catch (error) {
      if (error instanceof CardAuthorContractError) {
        return {
          response: {
            kind: "execute",
            action: {
              kind: "teach-clarify-context",
              input
            },
            source: decision.response.source
          },
          nextPendingProposal: null
        };
      }

      throw error;
    }
  }

  private async executeAction(
    action: ShellAction
  ): Promise<boolean> {
    this.writeDebug("execute action", this.describeAction(action));

    return this.withMeasuredStage(
      "execute action",
      this.describeAction(action),
      async () => {
        switch (action.kind) {
          case "quit": {
            const reaction = buildCompanionReaction(
              this.activePack,
              { type: "shell_exit" },
              this.getStatusSignals(),
              this.shellState.frame
            );
            this.surface.renderCompanionLine(reaction.lineOverride ?? "See you soon.");
            return true;
          }
          case "help":
            this.writeShellHelp();
            this.applyReaction({ type: "help" });
            return false;
          case "pet":
            this.applyReaction({ type: "pet_ping" });
            return false;
          case "stats":
            this.runStats();
            return false;
          case "rescue":
            await this.runRescue();
            return false;
          case "review-session":
            await this.runReview(
              parseCommand(["review", "session"])
            );
            return false;
          case "ask":
            await this.runAskInput(action.input);
            return false;
          case "capture":
            this.runCaptureInput(action.input);
            return false;
          case "teach-clarify-context":
            await this.runTeachClarification(action.input);
            return false;
          case "teach":
            await this.runTeachInput(action.input);
            return false;
          case "teach-confirm":
            await this.runTeachDraftConfirmation(action.input, action.draft);
            return false;
          case "command": {
            const command = parseCommand(tokenizeCommandLine(action.rawInput));
            await this.handleCommand(command);
            return false;
          }
          default:
            return false;
        }
      }
    );
  }

  private renderCompanion(): void {
    const status = this.getStatusSignals();
    this.surface.setMode?.("Chat", status.dueCount);
    this.surface.renderCompanionLine(
      renderCompanionPresenceLine(this.activePack, {
        mood: this.shellState.mood,
        frame: this.shellState.frame,
        dueCount: status.dueCount,
        recentWord: status.recentWord,
        lineOverride: this.shellState.lineOverride
      })
    );
    this.shellState.frame += 1;
    this.shellState.lineOverride = undefined;
  }

  private getStatusSignals(): CompanionStatusSignals {
    const signals = this.executor.getCompanionSignals();

    return {
      dueCount: signals.dueCount,
      recentWord: signals.recentWord
    };
  }

  private applyReaction(
    event: Parameters<typeof buildCompanionReaction>[1]
  ): void {
    const reaction = buildCompanionReaction(
      this.activePack,
      event,
      this.getStatusSignals(),
      this.shellState.frame
    );
    this.shellState.mood = reaction.mood;
    this.shellState.lineOverride = reaction.lineOverride;
  }

  private renderTransientCompanion(event: CompanionEvent): void {
    const status = this.getStatusSignals();
    const reaction = buildCompanionReaction(
      this.activePack,
      event,
      status,
      this.shellState.frame
    );
    this.surface.showWaitingIndicator(
      this.activePack.displayName,
      reaction.lineOverride ?? "Sniffing around..."
    );
    this.shellState.frame += 1;
  }

  private async withMeasuredStage<T>(
    label: string,
    fields: Record<string, ShellDebugField>,
    work: () => Promise<T> | T,
    waitingEvent?: CompanionEvent,
    suppressWaiting?: () => boolean
  ): Promise<T> {
    const startedAt = performance.now();
    let waitingShown = false;
    let failed = false;
    let shouldRender = true;
    const timer = setTimeout(() => {
      if (shouldRender && !suppressWaiting?.()) {
        waitingShown = true;
        if (waitingEvent) {
          this.renderTransientCompanion(waitingEvent);
        }
      }
    }, waitingEvent ? SHELL_WAIT_DELAY_MS : 0);

    try {
      return await Promise.resolve().then(work);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      shouldRender = false;
      clearTimeout(timer);
      this.surface.clearWaitingIndicator();
      this.writePerf(label, performance.now() - startedAt, {
        ...fields,
        waitingShown,
        ok: !failed
      });
    }
  }

  private async handleCommand(
    command: ReturnType<typeof parseCommand>
  ): Promise<void> {
    switch (command.name) {
      case "help":
        this.writeShellHelp();
        this.applyReaction({ type: "help" });
        return;
      case "pet":
        this.applyReaction({ type: "pet_ping" });
        return;
      case "capture":
        this.runCapture(command);
        return;
      case "ask":
        await this.runAsk(command);
        return;
      case "teach":
        await this.runTeach(command);
        return;
      case "review":
        await this.runReview(command);
        return;
      case "stats":
        this.runStats();
        return;
      case "highlight":
        this.runHighlight(command);
        return;
      case "rescue":
        await this.runRescue();
        return;
      case "model":
        await this.runModel(command);
        return;
      case "models":
        await this.runModels(command);
        return;
      default:
        throw new UsageError(`Unknown shell command: ${command.name}`);
    }
  }

  private runCapture(command: ReturnType<typeof parseCommand>): void {
    const word = command.args[0];
    const context = command.flags.ctx;
    const gloss = command.flags.gloss;

    if (!word?.trim()) {
      throw new UsageError("`capture` requires a word argument.");
    }

    if (!context) {
      throw new UsageError("`capture` requires --ctx.");
    }

    if (!gloss) {
      throw new UsageError("`capture` requires --gloss.");
    }

    this.runCaptureInput({
      word,
      context,
      gloss,
      sourceLabel: command.flags.source
    });
  }

  private async runAsk(command: ReturnType<typeof parseCommand>): Promise<void> {
    const word = command.args[0];
    const context = command.flags.ctx;

    if (!word?.trim()) {
      throw new UsageError("`ask` requires a word argument.");
    }

    if (!context) {
      throw new UsageError("`ask` requires --ctx.");
    }

    await this.runAskInput({
      word,
      context,
      provider: asProviderName(command.flags.provider),
      model: command.flags.model,
      apiKey: command.flags["api-key"],
      apiUrl: command.flags["api-url"]
    });
  }

  private async runTeach(command: ReturnType<typeof parseCommand>): Promise<void> {
    const word = command.args[0];
    const context = command.flags.ctx;

    if (!word?.trim()) {
      throw new UsageError("`teach` requires a word argument.");
    }

    if (!context) {
      throw new UsageError("`teach` requires --ctx.");
    }

    await this.runTeachInput({
      word,
      context,
      sourceLabel: command.flags.source,
      provider: asProviderName(command.flags.provider),
      model: command.flags.model,
      apiKey: command.flags["api-key"],
      apiUrl: command.flags["api-url"]
    });
  }

  private async runModel(command: ReturnType<typeof parseCommand>): Promise<void> {
    const subcommand = command.args[0];

    if (subcommand === undefined || subcommand === "show") {
      const formatted = formatLlmStatus(this.executor.getLlmStatus());
      this.writeDataBlock(formatted, "llm-status");
      this.sessionState.recordActionResult(
        formatted,
        JSON.stringify({ type: "model-status" })
      );
      return;
    }

    if (subcommand === "use" || subcommand === "set") {
      const provider = asProviderName(command.args[1]);
      const model = command.args[2];

      if (!provider) {
        throw new UsageError("`/model use` requires a provider name.");
      }

      this.executor.updateCurrentLlmSettings({
        provider,
        model,
        apiKey: command.flags["api-key"] ?? undefined,
        apiUrl: command.flags["api-url"] ?? undefined
      });

      const formatted = formatLlmStatus(this.executor.getLlmStatus());
      this.writeDataBlock(formatted, "llm-status");
      this.sessionState.recordActionResult(
        formatted,
        JSON.stringify({
          type: "model-set",
          provider,
          model: this.executor.getLlmStatus().model
        })
      );
      return;
    }

    if (subcommand === "list") {
      const provider = asProviderName(command.args[1] ?? command.flags.provider);
      const result = await this.withMeasuredStage(
        "model list",
        {
          provider: provider ?? "active"
        },
        () =>
          this.executor.listModels({
            provider,
            apiKey: command.flags["api-key"],
            apiUrl: command.flags["api-url"]
          }),
        { type: "study_wait" }
      );
      const formatted = formatLlmModelList(result);
      this.writeDataBlock(formatted, "llm-model-list");
      this.sessionState.recordActionResult(
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

      this.executor.setProviderApiUrl(provider, apiUrl);
      const formatted = formatLlmStatus(this.executor.getLlmStatus());
      this.writeDataBlock(formatted, "llm-status");
      this.sessionState.recordActionResult(
        formatted,
        JSON.stringify({
          type: "model-url",
          provider
        })
      );
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

      this.executor.setProviderApiKey(provider, apiKey);
      const formatted = formatLlmStatus(this.executor.getLlmStatus());
      this.writeDataBlock(formatted, "llm-status");
      this.sessionState.recordActionResult(
        formatted,
        JSON.stringify({
          type: "model-key",
          provider
        })
      );
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

    this.executor.updateCurrentLlmSettings({
      provider,
      model: modelToken,
      apiKey: command.flags["api-key"] ?? undefined,
      apiUrl: command.flags["api-url"] ?? undefined
    });

    const formatted = formatLlmStatus(this.executor.getLlmStatus());
    this.writeDataBlock(formatted, "llm-status");
    this.sessionState.recordActionResult(
      formatted,
      JSON.stringify({
        type: "model-set",
        provider,
        model: this.executor.getLlmStatus().model
      })
    );
  }

  private async runModels(command: ReturnType<typeof parseCommand>): Promise<void> {
    if (command.args.length > 1) {
      throw new UsageError("`/models` expects zero arguments or one provider name.");
    }

    const status = this.executor.getLlmStatus();
    const selectedProvider =
      command.args[0] !== undefined
        ? asProviderName(command.args[0])
        : ((await this.readShellSelection({
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

    const result = await this.withMeasuredStage(
      "model picker list",
      {
        provider: selectedProvider
      },
      () =>
        this.executor.listModels({
          provider: selectedProvider
        }),
      { type: "study_wait" }
    );

    if (result.models.length === 0) {
      const formatted = formatLlmModelList(result);
      this.writeDataBlock(formatted, "llm-model-list");
      this.sessionState.recordActionResult(
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
    const selectedModel = await this.readShellSelection({
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

    this.executor.updateCurrentLlmSettings({
      provider: selectedProvider,
      model: selectedModel
    });

    const formatted = formatLlmStatus(this.executor.getLlmStatus());
    this.writeDataBlock(formatted, "llm-status");
    this.sessionState.recordActionResult(
      formatted,
      JSON.stringify({
        type: "model-picker-set",
        provider: selectedProvider,
        model: selectedModel
      })
    );
  }

  private runStats(): void {
    const summary = this.executor.getCompanionSignals();
    const home = this.executor.getHomeProjection();
    const natural = presentShellStatsResult(summary, home);
    this.writeAssistantReplyNow(natural);
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "stats",
        dueCount: summary.dueCount,
        todayReviewedCount: summary.todayReviewedCount
      })
    );
    this.applyReaction({
      type: "stats_summary",
      todayReviewedCount: summary.todayReviewedCount,
      dueCount: summary.dueCount,
      capturedLast7Days: summary.capturedLast7Days,
      reviewedLast7Days: summary.reviewedLast7Days,
      stableCount: summary.masteryBreakdown.stable
    });
  }

  private runHighlight(command: ReturnType<typeof parseCommand>): void {
    const subcommand = command.args[0]?.toLowerCase();

    if (subcommand === undefined || subcommand === "show") {
      const natural = this.streamHighlight
        ? `Stream highlight is set to ${this.streamHighlight.percent}% of ${this.streamHighlight.totalChars} characters.`
        : "Stream highlight is using the default automatic window.";
      this.writeAssistantReplyNow(natural);
      this.sessionState.recordActionResult(
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
      this.surface.setStreamHighlight?.(null);
      const natural = "Stream highlight is back on the default automatic window.";
      this.writeAssistantReplyNow(natural);
      this.sessionState.recordActionResult(
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
    this.surface.setStreamHighlight?.(this.streamHighlight);
    const highlightChars = Math.max(1, Math.round((totalChars * percent) / 100));
    const natural = `Stream highlight now uses ${percent}% of ${totalChars} characters, so I'll accent the newest ${highlightChars} while a reply is still streaming.`;
    this.writeAssistantReplyNow(natural);
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "highlight-set",
        percent,
        totalChars,
        highlightChars
      })
    );
  }

  private async runReview(command: ReturnType<typeof parseCommand>): Promise<void> {
    const subcommand = command.args[0];

    switch (subcommand) {
      case undefined:
      case "session": {
        const limit = parseOptionalLimit(command.flags.limit);
        const reviewSummary = this.executor.getCompanionSignals();

        if (reviewSummary.dueCount === 0) {
          const natural = presentShellReviewIntro(reviewSummary);
          this.writeAssistantReplyNow(natural);
          this.sessionState.recordActionResult(
            natural,
            JSON.stringify({
              type: "review-session-empty-intro"
            })
          );
          this.applyReaction({ type: "review_session_empty" });
          return;
        }

        const intro = presentShellReviewIntro(reviewSummary);
        this.writeAssistantReplyNow(intro);
        const reviewSession = await this.executor.runReviewSession(
          this.surface.createReviewSessionTerminal(),
          { limit },
          createShellReviewSessionCopy()
        );
        const summary = presentShellReviewSessionSummary(
          reviewSession.result,
          reviewSession.returnAfterGap
        );
        this.writeAssistantReplyNow(summary);

        this.sessionState.recordActionResult(
          [intro, summary].join("\n"),
          JSON.stringify({
            type: "review-session",
            reviewedCount: reviewSession.result.reviewedCount,
            quitEarly: reviewSession.result.quitEarly,
            limitReached: reviewSession.result.limitReached,
            gradeCounts: reviewSession.result.gradeCounts,
            returnAfterGap: reviewSession.returnAfterGap
          })
        );
        this.applyReaction(
          buildReviewSessionCompanionEvent(
            reviewSession.result,
            reviewSession.returnAfterGap
          )
        );
        return;
      }
      case "next": {
        const result = this.executor.getNextReviewCard();
        const formatted = formatNextReviewCard(result);
        this.writeDataBlock(formatted, "review-next");
        this.sessionState.recordActionResult(
          formatted,
          JSON.stringify({
            type: "review-next",
            cardId: result?.id ?? null,
            word: result?.lemma ?? null
          })
        );
        this.applyReaction({
          type: "review_next",
          word: result?.lemma ?? null
        });
        return;
      }
      case "reveal": {
        const cardId = parsePositiveId(
          command.args[1],
          "`review reveal` requires a positive card id."
        );
        const result = this.executor.revealReviewCard(cardId);
        const formatted = formatReviewReveal(result);
        this.writeDataBlock(formatted, "review-reveal");
        this.sessionState.recordActionResult(
          formatted,
          JSON.stringify({
            type: "review-reveal",
            cardId: result.card.id,
            word: result.card.lemma
          })
        );
        this.applyReaction({
          type: "review_reveal",
          word: result.card.lemma
        });
        return;
      }
      default:
        throw new UsageError(`Unknown review command: ${subcommand}`);
    }
  }

  private async runRescue(): Promise<void> {
    const status = this.executor.getCompanionSignals();
    const home = this.executor.getHomeProjection();
    const candidate = this.executor.getRescueCandidate();

    if (!candidate) {
      const natural = presentShellNoRescueCandidate(status);
      this.writeAssistantReplyNow(natural);
      this.sessionState.recordActionResult(
        natural,
        JSON.stringify({
          type: "rescue-none",
          dueCount: status.dueCount
        })
      );
      return;
    }

    const intro = presentShellRescueIntro(candidate, home);
    this.writeAssistantReplyNow(intro);

    const introEvent = buildCompanionReaction(
      this.activePack,
      {
        type: "rescue_candidate",
        word: candidate.card.lemma,
        overdueDays: candidate.overdueDays
      },
      status,
      this.shellState.frame
    );
    this.shellState.mood = introEvent.mood;
    if (introEvent.lineOverride) {
      this.surface.renderCompanionLine(introEvent.lineOverride);
    }

    const rescueSession = await this.executor.runRescueSession(
      this.surface.createReviewSessionTerminal(),
      {},
      createShellReviewSessionCopy()
    );

    if (!rescueSession) {
      return;
    }

    const summary = presentShellReviewSessionSummary(rescueSession.result, null, {
      mode: "rescue",
      focusWord: candidate.card.lemma
    });
    this.writeAssistantReplyNow(summary);
    this.sessionState.recordActionResult(
      [intro, summary].join("\n"),
      JSON.stringify({
        type: "rescue",
        word: candidate.card.lemma,
        reviewedCount: rescueSession.result.reviewedCount,
        quitEarly: rescueSession.result.quitEarly,
        limitReached: rescueSession.result.limitReached,
        gradeCounts: rescueSession.result.gradeCounts
      })
    );

    this.applyReaction(
      rescueSession.result.reviewedCount > 0
        ? {
            type: "rescue_complete",
            word: candidate.card.lemma
          }
        : {
            type: "review_session_quit",
            reviewedCount: rescueSession.result.reviewedCount
          }
    );
  }

  private writeShellHelp(): void {
    const helpText = [
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

    this.surface.writeHelp(helpText);
    this.sessionState.recordActionResult(
      helpText,
      JSON.stringify({ type: "help" })
    );
  }

  private async readShellSelection(
    request: PromptSelectionRequest
  ): Promise<string> {
    while (true) {
      const terminal = this.surface.createReviewSessionTerminal();

      if (terminal.select) {
        const rawValue = await terminal.select(request);
        const resolved = resolvePromptSelection(request, rawValue);

        if (resolved) {
          return resolved;
        }
      } else {
        const rawValue = await terminal.prompt(
          formatPromptSelectionPrompt(request)
        );
        const resolved = resolvePromptSelection(request, rawValue);

        if (resolved) {
          return resolved;
        }
      }
    }
  }

  private writeDebug(
    event: string,
    fields: Record<string, ShellDebugField>
  ): void {
    if (!this.debugEnabled) {
      return;
    }

    const lines = [`Debug: ${event}`];

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }

      lines.push(`${key}: ${String(value)}`);
    }

    this.surface.writeDataBlock(lines.join("\n"), "plain");
  }

  private writePerf(
    event: string,
    elapsedMs: number,
    fields: Record<string, ShellDebugField>
  ): void {
    if (!this.debugEnabled) {
      return;
    }

    const lines = [`Perf: ${event}`, `elapsed: ${formatPerfMs(elapsedMs)}`];

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }

      lines.push(`${key}: ${String(value)}`);
    }

    this.surface.writeDataBlock(lines.join("\n"), "plain");
  }

  private describeAgentResponse(
    response: ShellAgentResponse
  ): Record<string, ShellDebugField> {
    if (response.kind === "message") {
      return {
        source: response.source,
        kind: response.kind,
        mood: response.mood,
        text: response.text
      };
    }

    return {
      source: response.source,
      kind: response.kind,
      action: response.action.kind
    };
  }

  private describeAction(
    action: ShellAction
  ): Record<string, ShellDebugField> {
    switch (action.kind) {
      case "ask":
      case "capture":
      case "teach-clarify-context":
      case "teach":
      case "teach-confirm":
        return {
          action: action.kind,
          word: action.input.word
        };
      case "command":
        return {
          action: action.kind,
          rawInput: action.rawInput
        };
      default:
        return {
          action: action.kind
        };
    }
  }

  private buildTeachDraftDecision(
    input: TeachWordInput,
    teachDraft: TeachWordDraftResult,
    source: ShellAgentResponse["source"]
  ): ShellAgentDecision {
    return {
      response: {
        kind: "message",
        mood: "curious",
        text: createTeachDraftConfirmationMessage(teachDraft),
        source
      },
      nextPendingProposal: {
        action: {
          kind: "teach-confirm",
          input,
          draft: teachDraft
        },
        confirmationMessage: createTeachDraftConfirmationMessage(teachDraft),
        cancelMessage: createTeachDraftCancelMessage(teachDraft),
        teachDraft
      }
    };
  }

  private async publishTeachDraftDecision(
    input: TeachWordInput,
    source: ShellAgentResponse["source"]
  ): Promise<void> {
    const teachDraft = await this.withMeasuredStage(
      "teach draft",
      { word: input.word },
      () =>
        this.executor.draftTeach(input, (event) => {
          this.writePerf(
            `teach ${event.stage.replace(/_/g, " ")}`,
            event.elapsedMs,
            { word: input.word }
          );
        }),
      { type: "study_wait" }
    );
    const draftDecision = this.buildTeachDraftDecision(input, teachDraft, source);
    this.sessionState.applyDecision(draftDecision);
    await this.handleDecision(draftDecision);
  }

  private async runTeachClarification(
    input: TeachWordInput
  ): Promise<void> {
    const promptLanguage = detectCardPromptLanguage(input.context);
    const clarificationMessage =
      promptLanguage === "zh"
        ? `我知道你想学 “${input.word}”，但这句话还不够拿来做例句卡。你想怎么继续？`
        : `I can tell you want to learn "${input.word}", but that still is not a usable example sentence for a review card. How do you want to continue?`;

    this.writeAssistantReplyNow(clarificationMessage);
    this.sessionState.recordActionResult(
      clarificationMessage,
      JSON.stringify({
        type: "teach-clarify-context",
        word: input.word
      })
    );

    const selection = await this.readShellSelection({
      promptText:
        promptLanguage === "zh"
          ? `怎么继续处理 “${input.word}”？`
          : `How should I continue with "${input.word}"?`,
      initialValue: "definition",
      choices: promptLanguage === "zh"
        ? [
            {
              value: "definition",
              label: "定义卡",
              aliases: ["1", "d"],
              description: "直接按词义起草一张卡"
            },
            {
              value: "example",
              label: "给例句",
              aliases: ["2", "e"],
              description: "我再给你一句包含这个词的句子"
            },
            {
              value: "explain",
              label: "只解释",
              aliases: ["3", "a"],
              description: "先解释这个词，不保存"
            }
          ]
        : [
            {
              value: "definition",
              label: "Definition card",
              aliases: ["1", "d"],
              description: "Draft a simple card from the gloss now"
            },
            {
              value: "example",
              label: "Give example",
              aliases: ["2", "e"],
              description: "I will give you a sentence with the word in it"
            },
            {
              value: "explain",
              label: "Explain only",
              aliases: ["3", "a"],
              description: "Explain it without saving"
            }
          ]
    });

    switch (selection) {
      case "definition":
        await this.publishTeachDraftDecision(
          {
            ...input,
            studyContextMode: "definition"
          },
          "planner"
        );
        return;
      case "example": {
        const exampleRequestMessage =
          promptLanguage === "zh"
            ? `发我一句带 “${input.word}” 的例句，我就按例句起草。`
            : `Send me one sentence with "${input.word}" in it and I'll draft the card from that.`;
        this.writeAssistantReplyNow(exampleRequestMessage);
        this.sessionState.recordActionResult(
          exampleRequestMessage,
          JSON.stringify({
            type: "teach-request-example",
            word: input.word
          })
        );

        const exampleContext = await this.readFreeformShellPrompt(
          promptLanguage === "zh" ? "例句: " : "Example: "
        );

        if (exampleContext.trim().length === 0) {
          const emptyExampleMessage =
            promptLanguage === "zh"
              ? `我还没有拿到例句，所以先不保存 “${input.word}”。`
              : `I still do not have an example sentence, so I did not save "${input.word}".`;
          this.writeAssistantReplyNow(emptyExampleMessage);
          this.sessionState.recordActionResult(
            emptyExampleMessage,
            JSON.stringify({
              type: "teach-example-missing",
              word: input.word
            })
          );
          return;
        }

        this.sessionState.recordUserUtterance(exampleContext);
        await this.publishTeachDraftDecision(
          {
            ...input,
            context: exampleContext,
            studyContextMode: "author"
          },
          "fast-path"
        );
        return;
      }
      case "explain":
        await this.runAskInput(
          {
            word: input.word,
            context: input.context,
            provider: input.provider,
            model: input.model,
            apiKey: input.apiKey,
            apiUrl: input.apiUrl
          }
        );
        return;
      default:
        return;
    }
  }

  private async readFreeformShellPrompt(promptText: string): Promise<string> {
    const terminal = this.surface.createReviewSessionTerminal();
    return terminal.prompt(promptText);
  }

  private runCaptureInput(input: CaptureWordInput): void {
    const startedAt = performance.now();
    const result = this.executor.capture(input);
    const natural = presentShellCaptureResult(result);

    this.writeAssistantReplyNow(natural);
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "capture",
        word: result.lexeme.lemma,
        cards: result.cards.map((card) => card.cardType)
      })
    );
    this.applyReaction({
      type: "capture_success",
      word: result.lexeme.lemma
    });
    this.writePerf("capture executor", performance.now() - startedAt, {
      word: result.lexeme.lemma,
      cards: result.cards.length
    });
  }

  private async runAskInput(
    input: AskWordInput
  ): Promise<void> {
    const result = await this.withMeasuredStage(
      "ask executor",
      { word: input.word },
      () => this.executor.ask(input),
      { type: "study_wait" }
    );
    const natural = presentShellAskResult(result);
    const cardIntent = createAskResultIntent(result);

    await this.withMeasuredStage(
      "ask render",
      { word: result.word },
      () => this.writeAssistantReply(natural)
    );
    this.surface.writeDataBlock(
      flattenStudyCardIntent(cardIntent),
      "plain",
      cardIntent
    );
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "ask",
        word: result.word,
        knownWord: result.knownWord
      })
    );
    this.applyReaction({
      type: "ask_ready",
      word: result.word
    });
  }

  private async runTeachInput(
    input: TeachWordInput
  ): Promise<void> {
    const result = await this.withMeasuredStage(
      "teach executor",
      { word: input.word },
      () =>
        this.executor.teach(input, (event) => {
          this.writePerf(
            `teach ${event.stage.replace(/_/g, " ")}`,
            event.elapsedMs,
            { word: input.word }
          );
        }),
      { type: "study_wait" }
    );
    const natural = presentShellTeachResult(result);

    await this.withMeasuredStage(
      "teach render",
      { word: result.ask.word },
      () => this.writeAssistantReply(natural)
    );
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "teach",
        word: result.ask.word,
        cards: result.capture.cards.map((card) => card.cardType)
      })
    );
    this.applyReaction({
      type: "teach_success",
      word: result.ask.word
    });
  }

  private async runTeachDraftConfirmation(
    input: TeachWordInput,
    draft: TeachWordDraftResult
  ): Promise<void> {
    const result = await this.withMeasuredStage(
      "teach confirm",
      { word: input.word },
      () =>
        this.executor.confirmTeachDraft(input, draft, (event) => {
          this.writePerf(
            `teach ${event.stage.replace(/_/g, " ")}`,
            event.elapsedMs,
            { word: input.word }
          );
        })
    );

    const natural = presentShellTeachResult(result);
    this.writeAssistantReplyNow(natural);
    this.sessionState.recordActionResult(
      natural,
      JSON.stringify({
        type: "teach-confirm",
        word: result.ask.word,
        cards: result.capture.cards.map((card) => card.cardType)
      })
    );
    this.applyReaction({
      type: "teach_success",
      word: result.ask.word
    });
  }

  private writeShellError(error: unknown): void {
    if (this.debugEnabled && error instanceof Error) {
      this.writeDebug("error", {
        name: error.name,
        message: error.message
      });
    }

    const natural = presentShellError(error);

    if (error instanceof ConfigurationError) {
      this.sessionState.recordError(natural);
      this.writeAssistantReplyNow(natural);

      return;
    }

    if (
      error instanceof UsageError ||
      error instanceof DuplicateEncounterError ||
      error instanceof NotFoundError ||
      error instanceof ReviewCardNotDueError ||
      error instanceof ExplanationContractError ||
      error instanceof CardAuthorContractError ||
      error instanceof ProviderRequestError
    ) {
      this.sessionState.recordError(natural);
      this.writeAssistantReplyNow(natural);
      return;
    }

    if (error instanceof Error) {
      this.sessionState.recordError(natural);
      this.writeAssistantReplyNow(natural);
      return;
    }

    this.sessionState.recordError(natural);
    this.writeAssistantReplyNow(natural);
  }

  private async writeAssistantReply(text: string): Promise<void> {
    await this.surface.writeAssistantReply(text);
  }

  private onPlannerMessageDelta(delta: string): void {
    if (!this.plannerMessageStreamStarted) {
      this.surface.beginAssistantReplyStream();
      this.plannerMessageStreamStarted = true;
    }

    this.surface.appendAssistantReplyDelta(delta);
  }

  private resetPlannerMessageStream(commit = false): void {
    if (!this.plannerMessageStreamStarted) {
      return;
    }

    this.surface.finishAssistantReplyStream(commit);
    this.plannerMessageStreamStarted = false;
  }

  private writeAssistantReplyNow(text: string): void {
    this.surface.writeAssistantReplyNow(text);
  }

  private writeDataBlock(text: string, kind: CliDataKind = "plain"): void {
    this.surface.writeDataBlock(text, kind);
  }

}
