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
  TeachWordInput
} from "../core/domain/models";
import { isLlmProviderName } from "../llm/provider-factory";
import type { LlmProvider } from "../llm/types";
import {
  ConfigurationError,
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
  type ShellAgentResponse
} from "./shell-agent";
import { LlmShellPlanner } from "./shell-planner";
import type { CliDataKind } from "./theme";
import { parseCommand, tokenizeCommandLine } from "./command-parser";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import {
  LineShellSurface,
  ReadlineShellTerminal,
  type ShellSurface,
  type ShellTerminal
} from "./shell-surface";
import { ShellSessionState } from "./shell-session-state";
import { ShellActionExecutor } from "./shell-action-executor";

export interface ShellRunnerOptions {
  db: SqliteDatabase;
  providerFactory?: (name: LlmProviderName) => LlmProvider;
  terminal?: ShellTerminal;
  surface?: ShellSurface;
  packId?: string;
}

interface ShellState {
  mood: CompanionMood;
  frame: number;
  lineOverride?: string;
}

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

export class ShellRunner {
  private readonly surface: ShellSurface;
  private readonly conversationAgent: ShellConversationAgent;
  private readonly sessionState = new ShellSessionState();
  private readonly executor: ShellActionExecutor;
  private readonly activePack: CompanionPackDefinition;
  private readonly shellState: ShellState = {
    mood: "idle",
    frame: 0
  };

  constructor(options: ShellRunnerOptions) {
    const terminal = options.terminal ?? new ReadlineShellTerminal();
    this.surface = options.surface ?? new LineShellSurface(terminal);
    this.executor = new ShellActionExecutor(options.db, options.providerFactory);
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

        try {
          this.sessionState.recordUserUtterance(rawInput);
          const decision = await this.withWaitingCapsule(
            { type: "planner_wait" },
            () =>
              this.conversationAgent.respond(rawInput, {
                pendingProposal: this.sessionState.getPendingProposal(),
                context: {
                  recentTurns: this.sessionState.listRecentTurns(6),
                  activePack: this.activePack,
                  statusSignals: this.getStatusSignals()
                }
              })
          );
          this.sessionState.applyDecision(decision);
          const shouldExit = await this.handleAgentResponse(decision.response);

          if (shouldExit) {
            return;
          }
        } catch (error) {
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
        }
      }
    } finally {
      await this.surface.close();
    }
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

  private async executeAction(
    action: ShellAction
  ): Promise<boolean> {
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
      case "teach":
        await this.runTeachInput(action.input);
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

  private async withWaitingCapsule<T>(
    event: CompanionEvent,
    work: () => Promise<T> | T
  ): Promise<T> {
    let shouldRender = true;
    const timer = setTimeout(() => {
      if (shouldRender) {
        this.renderTransientCompanion(event);
      }
    }, SHELL_WAIT_DELAY_MS);

    try {
      return await work();
    } finally {
      shouldRender = false;
      clearTimeout(timer);
      this.surface.clearWaitingIndicator();
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
      case "rescue":
        await this.runRescue();
        return;
      case "model":
        await this.runModel(command);
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
      const result = await this.withWaitingCapsule(
        { type: "study_wait" },
        () =>
          this.executor.listModels({
            provider,
            apiKey: command.flags["api-key"],
            apiUrl: command.flags["api-url"]
          })
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

  private runCaptureInput(input: CaptureWordInput): void {
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
  }

  private async runAskInput(input: AskWordInput): Promise<void> {
    const result = await this.withWaitingCapsule(
      { type: "study_wait" },
      () => this.executor.ask(input)
    );
    const natural = presentShellAskResult(result);

    await this.writeAssistantReply(natural);
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

  private async runTeachInput(input: TeachWordInput): Promise<void> {
    const result = await this.withWaitingCapsule(
      { type: "study_wait" },
      () => this.executor.teach(input)
    );
    const natural = presentShellTeachResult(result);

    await this.writeAssistantReply(natural);
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

  private writeShellError(error: unknown): void {
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

  private writeAssistantReplyNow(text: string): void {
    this.surface.writeAssistantReplyNow(text);
  }

  private writeDataBlock(text: string, kind: CliDataKind = "plain"): void {
    this.surface.writeDataBlock(text, kind);
  }
}
