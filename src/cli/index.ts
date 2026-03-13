#!/usr/bin/env node

import type { LlmProviderName, ReviewGrade } from "../core/domain/models";
import { loadCompanionPack, listCompanionPacks } from "../companion/packs";
import { renderCompanionCard } from "../companion/presenter";
import { buildCompanionReaction } from "../companion/reaction-builder";
import {
  ConfigurationError,
  DuplicateEncounterError,
  ExplanationContractError,
  NotFoundError,
  ProviderRequestError,
  ReviewCardNotDueError,
  UsageError
} from "../lib/errors";
import {
  formatAskResult,
  formatCompanionPacks,
  formatCaptureResult,
  formatGradeResult,
  formatHomeProjection,
  formatLlmModelList,
  formatLlmStatus,
  formatNextReviewCard,
  formatRecoveryProjection,
  formatRescueCandidate,
  formatReturnAfterGapSummary,
  formatReviewReveal,
  formatReviewSessionSummary,
  formatReviewQueue,
  formatSettings,
  formatStatsResult,
  formatTeachResult
} from "./format";
import {
  buildReviewSessionCompanionEvent
} from "./review-session-feedback";
import { createCliTheme, shouldUseColor } from "./theme";
import type { CliDataKind } from "./theme";
import {
  normalizeCliEntryArgv,
  parseCommand,
  type ParsedCommand
} from "./command-parser";
import { ShellRunner } from "./shell-runner";
import { ReadlineShellTerminal, TuiShellSurface } from "./shell-surface";
import { ShellActionExecutor } from "./shell-action-executor";
import { openDatabase } from "../storage/sqlite/database";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import { nowIso } from "../lib/time";
import { isLlmProviderName } from "../llm/provider-factory";
import { hasAnyProviderEnvApiKey } from "../llm/provider-metadata";
import { LlmConfigService } from "../llm/llm-config-service";

const stdoutTheme = createCliTheme({
  enabled: shouldUseColor(process.stdout)
});
const stderrTheme = createCliTheme({
  enabled: shouldUseColor(process.stderr)
});

function writeStdout(
  text: string,
  style:
    | "companion-card"
    | "companion-line"
    | "help"
    | { kind: CliDataKind } = { kind: "plain" }
): void {
  if (typeof style === "object") {
    process.stdout.write(`${stdoutTheme.dataBlock(text, style.kind)}\n`);
    return;
  }

  switch (style) {
    case "companion-card":
      process.stdout.write(`${stdoutTheme.companionCard(text)}\n`);
      return;
    case "companion-line":
      process.stdout.write(`${stdoutTheme.companionLine(text)}\n`);
      return;
    case "help":
      process.stdout.write(`${stdoutTheme.help(text)}\n`);
      return;
    default:
      process.stdout.write(`${stdoutTheme.dataBlock(text, "plain")}\n`);
  }
}

function printHelp(): void {
  writeStdout(
    [
      "PawMemo CLI",
      "",
      "Default entry:",
      "  pawmemo [--line] [--debug] [--db path]",
      "",
      "Commands:",
      "  pawmemo capture <word> --ctx \"...\" --gloss \"...\" [--source \"...\"] [--db path]",
      "  pawmemo review [--limit N] [--db path]",
      "  pawmemo review next [--db path]",
      "  pawmemo review reveal <card-id> [--db path]",
      "  pawmemo review session [--limit N] [--db path]",
      "  pawmemo grade <card-id> --grade <again|hard|good|easy> [--at ISO] [--db path]",
      "  pawmemo ask <word> --ctx \"...\" [--provider PROVIDER] [--model MODEL] [--api-key KEY] [--api-url URL] [--db path]",
      "  pawmemo teach <word> --ctx \"...\" [--source label] [--provider PROVIDER] [--model MODEL] [--api-key KEY] [--api-url URL] [--db path]",
      "  pawmemo rescue [--at ISO] [--db path]",
      "  pawmemo pet [--db path]",
      "  pawmemo pet [--pack PACK_ID] [--db path]",
      "  pawmemo shell [--line] [--debug] [--db path]",
      "  pawmemo stats [--db path]",
      "  pawmemo config show [--db path]",
      "  pawmemo config llm [show] [--db path]",
      "  pawmemo config llm list-models [--provider PROVIDER] [--api-key KEY] [--api-url URL] [--db path]",
      "  pawmemo config llm use --provider PROVIDER [--model MODEL] [--api-key KEY] [--api-url URL] [--db path]",
      "  pawmemo config llm key --provider PROVIDER --api-key KEY [--db path]",
      "  pawmemo config llm url --provider PROVIDER --api-url URL [--db path]",
      "  pawmemo config companion list [--db path]",
      "  pawmemo config companion --pack PACK_ID [--db path]",
      "",
      "Examples:",
      "  pawmemo",
      "  pawmemo --line",
      "  pawmemo capture luminous --ctx \"The jellyfish gave off a luminous glow.\" --gloss \"emitting light\"",
      "  pawmemo review --limit 5",
      "  pawmemo review next",
      "  pawmemo review reveal 1",
      "  pawmemo review session --limit 10",
      "  pawmemo grade 1 --grade good",
      "  pawmemo ask luminous --ctx \"The jellyfish gave off a luminous glow.\"",
      "  pawmemo teach luminous --ctx \"The jellyfish gave off a luminous glow.\"",
      "  pawmemo rescue",
      "  pawmemo pet",
      "  pawmemo shell",
      "  pawmemo shell --line",
      "  pawmemo shell --debug",
      "  pawmemo stats",
      "  pawmemo config llm",
      "  pawmemo config llm use --provider openai --model gpt-5-mini --api-key KEY",
      "  pawmemo config llm url --provider openai --api-url http://172.24.160.1:7861/v1",
      "  pawmemo config llm list-models --provider anthropic",
      "  pawmemo config companion list",
      "  pawmemo config companion --pack girlfriend",
      ""
    ].join("\n"),
    "help"
  );
}

function runCapture(command: ParsedCommand): void {
  const word = command.args[0];

  if (!word || word.trim().length === 0) {
    throw new UsageError("`capture` requires a word argument.");
  }

  const context = command.flags.ctx;
  const gloss = command.flags.gloss;

  if (!context) {
    throw new UsageError("`capture` requires --ctx.");
  }

  if (!gloss) {
    throw new UsageError("`capture` requires --gloss.");
  }

  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const result = executor.capture({
      word,
      context,
      gloss,
      sourceLabel: command.flags.source
    });

    writeStdout(formatCaptureResult(result), { kind: "capture-result" });
  } finally {
    db.close();
  }
}

function runStats(command: ParsedCommand): void {
  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const summary = executor.getCompanionSignals();
    const recovery = executor.getRecoveryProjection();
    const settings = new AppSettingsRepository(db);
    const pack = loadCompanionPack(settings.getCompanionPackId());
    const reaction = buildCompanionReaction(
      pack,
      {
        type: "stats_summary",
        todayReviewedCount: summary.todayReviewedCount,
        dueCount: summary.dueCount,
        capturedLast7Days: summary.capturedLast7Days,
        reviewedLast7Days: summary.reviewedLast7Days,
        stableCount: summary.masteryBreakdown.stable
      },
      {
        dueCount: summary.dueCount,
        recentWord: null
      },
      0
    );

    writeStdout(formatStatsResult(summary), { kind: "stats" });
    writeStdout(formatRecoveryProjection(recovery), { kind: "recovery" });

    if (reaction.lineOverride) {
      writeStdout(reaction.lineOverride, "companion-line");
    }
  } finally {
    db.close();
  }
}

async function runReview(command: ParsedCommand): Promise<void> {
  const subcommand = command.args[0];
  const rawLimit = command.flags.limit;
  const limit =
    rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);

  if (rawLimit !== undefined && Number.isNaN(limit)) {
    throw new UsageError("`review` requires --limit to be a number.");
  }

  if (typeof limit === "number" && limit < 0) {
    throw new UsageError("`review` requires --limit to be zero or greater.");
  }

  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);

    switch (subcommand) {
      case undefined: {
        const result = executor.getReviewQueue({
          limit
        });

        writeStdout(formatReviewQueue(result), { kind: "review-queue" });
        return;
      }
      case "next": {
        const result = executor.getNextReviewCard();
        writeStdout(formatNextReviewCard(result), { kind: "review-next" });
        return;
      }
      case "reveal": {
        const cardId = Number.parseInt(command.args[1] ?? "", 10);

        if (Number.isNaN(cardId) || cardId <= 0) {
          throw new UsageError("`review reveal` requires a positive card id.");
        }

        const result = executor.revealReviewCard(cardId);
        writeStdout(formatReviewReveal(result), { kind: "review-reveal" });
        return;
      }
      case "session": {
        const reviewSession = await executor.runReviewSessionWithDefaultTerminal({
          limit
        });
        writeStdout(formatReviewSessionSummary(reviewSession.result), {
          kind: "review-summary"
        });

        if (reviewSession.returnAfterGap) {
          writeStdout(formatReturnAfterGapSummary(reviewSession.returnAfterGap), {
            kind: "return-summary"
          });
        }

        const settings = new AppSettingsRepository(db);
        const pack = loadCompanionPack(settings.getCompanionPackId());
        const event = buildReviewSessionCompanionEvent(
          reviewSession.result,
          reviewSession.returnAfterGap
        );
        const reaction = buildCompanionReaction(
          pack,
          event,
          reviewSession.signalsAfter,
          0
        );

        if (reaction.lineOverride) {
          writeStdout(reaction.lineOverride, "companion-line");
        }
        return;
      }
      default:
        throw new UsageError(`Unknown review command: ${subcommand}`);
    }
  } finally {
    db.close();
  }
}

async function runRescue(command: ParsedCommand): Promise<void> {
  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const candidate = executor.getRescueCandidate(command.flags.at);
    writeStdout(formatRescueCandidate(candidate), { kind: "rescue" });

    if (!candidate) {
      return;
    }

    const settings = new AppSettingsRepository(db);
    const pack = loadCompanionPack(settings.getCompanionPackId());
    const status = executor.getCompanionSignals(command.flags.at);
    const introReaction = buildCompanionReaction(
      pack,
      {
        type: "rescue_candidate",
        word: candidate.card.lemma,
        overdueDays: candidate.overdueDays
      },
      status,
      0
    );

    if (introReaction.lineOverride) {
      writeStdout(introReaction.lineOverride, "companion-line");
    }

    const rescueSession = await executor.runRescueSessionWithDefaultTerminal({
      now: command.flags.at
    });

    if (!rescueSession) {
      return;
    }

    writeStdout(formatReviewSessionSummary(rescueSession.result), {
      kind: "review-summary"
    });

    const event =
      rescueSession.result.reviewedCount > 0
        ? {
            type: "rescue_complete" as const,
            word: candidate.card.lemma
          }
        : {
            type: "review_session_quit" as const,
            reviewedCount: rescueSession.result.reviewedCount
          };
    const reaction = buildCompanionReaction(
      pack,
      event,
      executor.getCompanionSignals(command.flags.at),
      0
    );

    if (reaction.lineOverride) {
      writeStdout(reaction.lineOverride, "companion-line");
    }
  } finally {
    db.close();
  }
}

function runGrade(command: ParsedCommand): void {
  const cardId = Number.parseInt(command.args[0] ?? "", 10);

  if (Number.isNaN(cardId)) {
    throw new UsageError("`grade` requires a numeric card id.");
  }

  if (cardId <= 0) {
    throw new UsageError("`grade` requires a positive card id.");
  }

  const grade = command.flags.grade;

  if (!grade) {
    throw new UsageError("`grade` requires --grade.");
  }

  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const result = executor.gradeReviewCard({
      cardId,
      grade: grade as ReviewGrade,
      reviewedAt: command.flags.at
    });

    writeStdout(formatGradeResult(result), { kind: "grade-result" });
  } finally {
    db.close();
  }
}

async function runAsk(command: ParsedCommand): Promise<void> {
  const word = command.args[0];

  if (!word || word.trim().length === 0) {
    throw new UsageError("`ask` requires a word argument.");
  }

  const context = command.flags.ctx;

  if (!context) {
    throw new UsageError("`ask` requires --ctx.");
  }

  if (command.flags.provider && !isLlmProviderName(command.flags.provider)) {
    throw new UsageError(`Unsupported provider: ${command.flags.provider}`);
  }

  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const result = await executor.ask({
      word,
      context,
      provider: command.flags.provider as LlmProviderName | undefined,
      model: command.flags.model,
      apiKey: command.flags["api-key"],
      apiUrl: command.flags["api-url"]
    });

    writeStdout(formatAskResult(result), { kind: "ask-result" });
  } finally {
    db.close();
  }
}

async function runTeach(command: ParsedCommand): Promise<void> {
  const word = command.args[0];

  if (!word || word.trim().length === 0) {
    throw new UsageError("`teach` requires a word argument.");
  }

  const context = command.flags.ctx;

  if (!context) {
    throw new UsageError("`teach` requires --ctx.");
  }

  if (command.flags.provider && !isLlmProviderName(command.flags.provider)) {
    throw new UsageError(`Unsupported provider: ${command.flags.provider}`);
  }

  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const result = await executor.teach({
      word,
      context,
      sourceLabel: command.flags.source,
      provider: command.flags.provider as LlmProviderName | undefined,
      model: command.flags.model,
      apiKey: command.flags["api-key"],
      apiUrl: command.flags["api-url"]
    });

    writeStdout(formatTeachResult(result), { kind: "teach-result" });
  } finally {
    db.close();
  }
}

function runPet(command: ParsedCommand): void {
  const db = openDatabase(command.flags.db);

  try {
    const executor = new ShellActionExecutor(db);
    const settings = new AppSettingsRepository(db);
    const status = executor.getCompanionSignals();
    const home = executor.getHomeProjection();
    const pack = loadCompanionPack(
      command.flags.pack ?? settings.getCompanionPackId()
    );
    const reaction = buildCompanionReaction(
      pack,
      { type: "status_snapshot" },
      status,
      0
    );

    writeStdout(
      renderCompanionCard(pack, {
        mood: reaction.mood,
        frame: 0,
        dueCount: status.dueCount,
        recentWord: status.recentWord
      }),
      "companion-card"
    );
    writeStdout(formatHomeProjection(home), { kind: "home" });
  } finally {
    db.close();
  }
}

async function runShell(command: ParsedCommand): Promise<void> {
  const db = openDatabase(command.flags.db);

  try {
    const terminal = new ReadlineShellTerminal();
    const wantsLine = command.flags.line === "true";
    const wantsTui = command.flags.tui === "true";
    const useTui =
      !wantsLine &&
      (wantsTui ||
        (process.stdin.isTTY === true && process.stdout.isTTY === true));
    const runner = new ShellRunner({
      db,
      terminal,
      surface: useTui
        ? new TuiShellSurface(terminal, {
            debug: command.flags.debug === "true"
          })
        : undefined,
      packId: command.flags.pack,
      debug: command.flags.debug === "true"
    });
    await runner.run();
  } finally {
    db.close();
  }
}

async function runConfig(command: ParsedCommand): Promise<void> {
  const subcommand = command.args[0];
  const db = openDatabase(command.flags.db);

  try {
    const settings = new AppSettingsRepository(db);
    const llmConfig = new LlmConfigService(db);

    switch (subcommand) {
      case "show":
      case undefined: {
        const apiKeyPresent =
          settings.hasAnyStoredApiKey() || hasAnyProviderEnvApiKey();
        writeStdout(formatSettings(settings.list(), apiKeyPresent), {
          kind: "settings"
        });
        return;
      }
      case "llm": {
        const hasUseFlags =
          command.flags.provider !== undefined ||
          command.flags.model !== undefined ||
          command.flags["api-key"] !== undefined ||
          command.flags["api-url"] !== undefined;
        const llmSubcommand =
          command.args[1] === undefined && hasUseFlags
            ? "use"
            : command.args[1];

        if (llmSubcommand === undefined || llmSubcommand === "show") {
          writeStdout(formatLlmStatus(llmConfig.getStatusSummary()), {
            kind: "llm-status"
          });
          return;
        }

        if (llmSubcommand === "list-models") {
          const provider = command.flags.provider;

          if (provider && !isLlmProviderName(provider)) {
            throw new UsageError(`Unsupported provider: ${provider}`);
          }

          const result = await llmConfig.listModels({
            provider: provider as LlmProviderName | undefined,
            apiKey: command.flags["api-key"],
            apiUrl: command.flags["api-url"]
          });
          writeStdout(formatLlmModelList(result), { kind: "llm-model-list" });
          return;
        }

        if (llmSubcommand === "key") {
          const provider = command.flags.provider;
          const apiKey = command.flags["api-key"];

          if (!provider) {
            throw new UsageError("`config llm key` requires --provider.");
          }

          if (!isLlmProviderName(provider)) {
            throw new UsageError(`Unsupported provider: ${provider}`);
          }

          if (!apiKey) {
            throw new UsageError("`config llm key` requires --api-key.");
          }

          llmConfig.setProviderApiKey(provider, apiKey);
          writeStdout(formatLlmStatus(llmConfig.getStatusSummary()), {
            kind: "llm-status"
          });
          return;
        }

        if (llmSubcommand === "url") {
          const provider = command.flags.provider;
          const apiUrl = command.flags["api-url"];

          if (!provider) {
            throw new UsageError("`config llm url` requires --provider.");
          }

          if (!isLlmProviderName(provider)) {
            throw new UsageError(`Unsupported provider: ${provider}`);
          }

          if (!apiUrl) {
            throw new UsageError("`config llm url` requires --api-url.");
          }

          llmConfig.setProviderApiUrl(provider, apiUrl);
          writeStdout(formatLlmStatus(llmConfig.getStatusSummary()), {
            kind: "llm-status"
          });
          return;
        }

        if (llmSubcommand !== "use") {
          throw new UsageError(
            [
              "`config llm` expects one of:",
              "  `config llm`",
              "  `config llm show`",
              "  `config llm list-models [--provider PROVIDER] [--api-key KEY] [--api-url URL]`",
              "  `config llm use --provider PROVIDER [--model MODEL] [--api-key KEY] [--api-url URL]`",
              "  `config llm key --provider PROVIDER --api-key KEY`",
              "  `config llm url --provider PROVIDER --api-url URL`"
            ].join("\n")
          );
        }

        const provider = command.flags.provider;
        const model = command.flags.model;
        const apiKey = command.flags["api-key"];
        const apiUrl = command.flags["api-url"];

        if (!provider) {
          throw new UsageError("`config llm use` requires --provider.");
        }

        if (!isLlmProviderName(provider)) {
          throw new UsageError(`Unsupported provider: ${provider}`);
        }

        llmConfig.updateCurrentSettings({
          provider,
          model,
          apiKey: apiKey ?? undefined,
          apiUrl: apiUrl ?? undefined
        });

        writeStdout(formatLlmStatus(llmConfig.getStatusSummary()), {
          kind: "llm-status"
        });
        return;
      }
      case "companion": {
        const packFlag = command.flags.pack;

        if (command.args[1] === "list") {
          writeStdout(
            formatCompanionPacks(
              listCompanionPacks(),
              settings.getCompanionPackId()
            ),
            { kind: "companion-packs" }
          );
          return;
        }

        if (!packFlag) {
          throw new UsageError("`config companion` requires --pack or `list`.");
        }

        const pack = loadCompanionPack(packFlag);
        settings.setCompanionPackId(pack.id, nowIso());

        writeStdout(
          formatCompanionPacks(
            listCompanionPacks(),
            settings.getCompanionPackId()
          ),
          { kind: "companion-packs" }
        );
        return;
      }
      default:
        throw new UsageError(`Unknown config command: ${subcommand}`);
    }
  } finally {
    db.close();
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const command = parseCommand(normalizeCliEntryArgv(argv));

  switch (command.name) {
    case "capture":
      runCapture(command);
      return;
    case "review":
      await runReview(command);
      return;
    case "grade":
      runGrade(command);
      return;
    case "ask":
      await runAsk(command);
      return;
    case "teach":
      await runTeach(command);
      return;
    case "rescue":
      await runRescue(command);
      return;
    case "pet":
      runPet(command);
      return;
    case "stats":
      runStats(command);
      return;
    case "shell":
      await runShell(command);
      return;
    case "config":
      await runConfig(command);
      return;
    default:
      throw new UsageError(`Unknown command: ${command.name}`);
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  if (
    error instanceof UsageError ||
    error instanceof DuplicateEncounterError ||
    error instanceof NotFoundError ||
    error instanceof ReviewCardNotDueError ||
    error instanceof ConfigurationError ||
    error instanceof ExplanationContractError ||
    error instanceof ProviderRequestError
  ) {
    process.stderr.write(`${stderrTheme.error(error.message)}\n`);
    process.exitCode = 1;
  } else if (error instanceof Error) {
    process.stderr.write(`${stderrTheme.error(`${error.name}: ${error.message}`)}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`${stderrTheme.error("Unknown error.")}\n`);
    process.exitCode = 1;
  }
});
