import { performance } from "node:perf_hooks";
import {
  renderCompanionPresenceLine
} from "../companion/presenter";
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
  TeachWordDraftOutcome,
  TeachWordDraftResult,
  TeachWordInput
} from "../core/domain/models";
import type { LlmProvider } from "../llm/types";
import { UsageError } from "../lib/errors";
import type { SqliteDatabase } from "../storage/sqlite/database";
import {
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
  type ShellAgentContext
} from "./shell-agent";
import type {
  ShellAction,
  ShellAgentDecision,
  ShellAgentResponse
} from "./shell-contract";
import { LlmShellPlanner } from "./shell-planner";
import type { CliDataKind } from "./theme";
import { parseCommand, tokenizeCommandLine } from "./command-parser";
import { ShellControlCommands } from "./shell-control-commands";
import { asProviderName } from "./shell-command-helpers";
import { ShellStartupCoordinator } from "./shell-startup";
import {
  LineShellSurface,
  ReadlineShellTerminal,
  ShellSurfaceAbortError,
  type ShellSurface,
  type ShellTerminal
} from "./shell-surface";
import { ShellSessionState } from "./shell-session-state";
import { ShellActionExecutor } from "./shell-action-executor";
import {
  createAskResultIntent,
  createTeachDraftIntent,
  flattenStudyCardIntent
} from "./study-card-view";
import { ShellTeachFlowCoordinator } from "./shell-teach-flow";
import {
  describeShellAction,
  describeShellAgentResponse,
  writeShellDebug,
  writeShellPerf,
  type ShellDebugField
} from "./shell-debug";

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

export class ShellRunner {
  private readonly surface: ShellSurface;
  private readonly conversationAgent: ShellConversationAgent;
  private readonly sessionState = new ShellSessionState();
  private readonly executor: ShellActionExecutor;
  private readonly controlCommands: ShellControlCommands;
  private readonly startupCoordinator = new ShellStartupCoordinator();
  private readonly teachFlow = new ShellTeachFlowCoordinator();
  private readonly activePack: CompanionPackDefinition;
  private readonly debugEnabled: boolean;
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
    this.activePack = this.executor.getActiveCompanionPack(options.packId);
    this.controlCommands = new ShellControlCommands({
      executor: this.executor,
      sessionState: this.sessionState,
      writeHelp: (text) => this.surface.writeHelp(text),
      writeAssistantReplyNow: (text) => this.writeAssistantReplyNow(text),
      writeDataBlock: (text, kind = "plain") => this.writeDataBlock(text, kind),
      readShellSelection: (request) => this.readShellSelection(request),
      runWithStudyWait: (label, fields, work) =>
        this.withMeasuredStage(label, fields, work, { type: "study_wait" }),
      setStreamHighlight: (config) => this.surface.setStreamHighlight?.(config)
    });
    this.conversationAgent = new ShellConversationAgent(
      new LlmShellPlanner(this.executor, options.providerFactory)
    );
  }

  async run(): Promise<void> {
    this.surface.beginShell(this.activePack.displayName);
    this.presentStartupEntry();
    writeShellDebug(this.surface, this.debugEnabled, "shell start", {
      pack: this.activePack.id,
      surface: this.surface.constructor.name,
      debug: this.debugEnabled
    });

    try {
      while (true) {
        this.renderCompanion();
        let rawInput: string;
        try {
          rawInput = (
            await this.surface.prompt()
          ).trim();
        } catch (error) {
          if (error instanceof ShellSurfaceAbortError) {
            return;
          }

          throw error;
        }

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
                  statusSignals: this.getStatusSignals(),
                  homeProjection: this.executor.getHomeProjection()
                } satisfies ShellAgentContext,
                onPlannerMessageDelta: (delta) => {
                  this.onPlannerMessageDelta(delta);
                }
              }),
              { type: "planner_wait" },
              () => this.plannerMessageStreamStarted
            );
          const preparedDecision = await this.prepareDecision(decision);
          writeShellDebug(
            this.surface,
            this.debugEnabled,
            "agent response",
            describeShellAgentResponse(preparedDecision.response)
          );
          writeShellDebug(this.surface, this.debugEnabled, "pending proposal", {
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
          if (error instanceof ShellSurfaceAbortError) {
            return;
          }

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
          writeShellPerf(
            this.surface,
            this.debugEnabled,
            "turn",
            performance.now() - turnStartedAt,
            {
            outcome: turnOutcome,
            exit: shouldExit,
            inputLength: rawInput.length
            }
          );
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
        this.teachFlow.buildDraftSelectionRequest(
          decision.nextPendingProposal.teachDraft
        )
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
    const teachDraft = await this.loadTeachDraftOutcome(input);
    return this.teachFlow.prepareDecision(
      input,
      teachDraft,
      decision.response.source
    );
  }

  private async executeAction(
    action: ShellAction
  ): Promise<boolean> {
    writeShellDebug(
      this.surface,
      this.debugEnabled,
      "execute action",
      describeShellAction(action)
    );

    return this.withMeasuredStage(
      "execute action",
      describeShellAction(action),
      async () => {
        switch (action.kind) {
          case "quit": {
            const reaction = this.executor.buildCompanionReaction(
              { type: "shell_exit" },
              {
                frame: this.shellState.frame,
                packId: this.activePack.id,
                status: this.getStatusSignals()
              }
            );
            this.surface.renderCompanionLine(reaction.lineOverride ?? "See you soon.");
            return true;
          }
          case "help":
            await this.controlCommands.handle(parseCommand(["help"]));
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

  private presentStartupEntry(): void {
    const summary = this.executor.getCompanionSignals();
    const home = this.executor.getHomeProjection();
    const entry = this.startupCoordinator.createEntry(summary, home);

    this.shellState.mood = entry.mood;
    this.startupCoordinator.renderEntry(this.surface, entry);

    if (entry.text) {
      this.sessionState.recordAssistantMessage(entry.text);
    }
  }

  private getStatusSignals(): CompanionStatusSignals {
    const signals = this.executor.getCompanionSignals();

    return {
      dueCount: signals.dueCount,
      recentWord: signals.recentWord
    };
  }

  private applyReaction(
    event: CompanionEvent
  ): void {
    const reaction = this.executor.buildCompanionReaction(
      event,
      {
        frame: this.shellState.frame,
        packId: this.activePack.id,
        status: this.getStatusSignals()
      }
    );
    this.shellState.mood = reaction.mood;
    this.shellState.lineOverride = reaction.lineOverride;
  }

  private renderTransientCompanion(event: CompanionEvent): void {
    const status = this.getStatusSignals();
    const reaction = this.executor.buildCompanionReaction(
      event,
      {
        frame: this.shellState.frame,
        packId: this.activePack.id,
        status
      }
    );
    this.surface.showWaitingIndicator(
      this.activePack.displayName,
      reaction.lineOverride ?? "Sniffing around..."
    );
    this.shellState.frame += 1;
  }

  private loadTeachDraftOutcome(
    input: TeachWordInput
  ): Promise<TeachWordDraftOutcome> {
    return this.withMeasuredStage(
      "teach draft",
      { word: input.word },
      () =>
        this.executor.draftTeach(input, (event) => {
          writeShellPerf(
            this.surface,
            this.debugEnabled,
            `teach ${event.stage.replace(/_/g, " ")}`,
            event.elapsedMs,
            { word: input.word }
          );
        }),
      { type: "study_wait" }
    );
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
      writeShellPerf(this.surface, this.debugEnabled, label, performance.now() - startedAt, {
        ...fields,
        waitingShown,
        ok: !failed
      });
    }
  }

  private async handleCommand(
    command: ReturnType<typeof parseCommand>
  ): Promise<void> {
    if (await this.controlCommands.handle(command)) {
      if (command.name === "help") {
        this.applyReaction({ type: "help" });
      }
      return;
    }

    switch (command.name) {
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

    const introEvent = this.executor.buildCompanionReaction(
      {
        type: "rescue_candidate",
        word: candidate.card.lemma,
        overdueDays: candidate.overdueDays
      },
      {
        frame: this.shellState.frame,
        packId: this.activePack.id,
        status
      }
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

  private async publishTeachDraftDecision(
    input: TeachWordInput,
    source: ShellAgentResponse["source"]
  ): Promise<void> {
    const teachDraft = await this.loadTeachDraftOutcome(input);
    const draftDecision = this.teachFlow.prepareDecision(input, teachDraft, source);
    this.sessionState.applyDecision(draftDecision);
    await this.handleDecision(draftDecision);
  }

  private async runTeachClarification(
    input: TeachWordInput
  ): Promise<void> {
    const clarificationMessage = this.teachFlow.createClarificationMessage(input);
    this.writeAssistantReplyNow(clarificationMessage);
    this.sessionState.recordActionResult(
      clarificationMessage,
      JSON.stringify({
        type: "teach-clarify-context",
        word: input.word
      })
    );

    const selection = await this.readShellSelection(
      this.teachFlow.buildClarificationRequest(input)
    );

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
        const exampleRequestMessage = this.teachFlow.createExampleRequestMessage(input);
        this.writeAssistantReplyNow(exampleRequestMessage);
        this.sessionState.recordActionResult(
          exampleRequestMessage,
          JSON.stringify({
            type: "teach-request-example",
            word: input.word
          })
        );

        const exampleContext = await this.readFreeformShellPrompt(
          this.teachFlow.createExamplePromptLabel(input)
        );

        if (exampleContext.trim().length === 0) {
          const emptyExampleMessage = this.teachFlow.createExampleMissingMessage(input);
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
    writeShellPerf(
      this.surface,
      this.debugEnabled,
      "capture executor",
      performance.now() - startedAt,
      {
      word: result.lexeme.lemma,
      cards: result.cards.length
      }
    );
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
          writeShellPerf(
            this.surface,
            this.debugEnabled,
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
          writeShellPerf(
            this.surface,
            this.debugEnabled,
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
      writeShellDebug(this.surface, this.debugEnabled, "error", {
        name: error.name,
        message: error.message
      });
    }

    const natural = presentShellError(error);
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
