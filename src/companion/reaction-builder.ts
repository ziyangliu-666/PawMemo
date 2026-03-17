import {
  interpolateCompanionTemplate,
  renderCompanionReaction
} from "./packs";
import type {
  CompanionDynamicTemplateBank,
  CompanionEvent,
  CompanionPackDefinition,
  CompanionReactionKey,
  CompanionReactionResult,
  CompanionStatusSignals,
  CompanionTemplateContext
} from "./types";

function resolveReaction(
  pack: CompanionPackDefinition,
  key: CompanionReactionKey,
  context: CompanionTemplateContext,
  frame: number
): string | undefined {
  const line = renderCompanionReaction(pack, key, context, frame).trim();
  return line.length > 0 ? line : undefined;
}

function resolveDynamicTemplate(
  dynamicTemplates: CompanionDynamicTemplateBank | undefined,
  key: CompanionReactionKey | "status_snapshot",
  context: CompanionTemplateContext
): string | undefined {
  const template = dynamicTemplates?.[key];

  if (!template) {
    return undefined;
  }

  const line = interpolateCompanionTemplate(template, context).trim();
  return line.length > 0 ? line : undefined;
}

function resolveReactionLine(
  pack: CompanionPackDefinition,
  key: CompanionReactionKey,
  context: CompanionTemplateContext,
  frame: number,
  dynamicTemplates?: CompanionDynamicTemplateBank
): string | undefined {
  return (
    resolveDynamicTemplate(dynamicTemplates, key, context) ??
    resolveReaction(pack, key, context, frame)
  );
}

export function buildCompanionReaction(
  pack: CompanionPackDefinition,
  event: CompanionEvent,
  status: CompanionStatusSignals,
  frame: number,
  dynamicTemplates?: CompanionDynamicTemplateBank
): CompanionReactionResult {
  switch (event.type) {
    case "status_snapshot":
      return {
        mood: status.dueCount > 0 ? "studying" : status.recentWord ? "idle" : "sleepy",
        lineOverride: resolveDynamicTemplate(
          dynamicTemplates,
          "status_snapshot",
          status
        )
      };
    case "planner_wait":
      return {
        mood: "curious",
        lineOverride: resolveReactionLine(
          pack,
          "planner_wait",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "study_wait":
      return {
        mood: "studying",
        lineOverride: resolveReactionLine(
          pack,
          "study_wait",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "help":
      return {
        mood: "idle",
        lineOverride: resolveReactionLine(
          pack,
          "help",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "pet_ping":
      return {
        mood: status.dueCount > 0 ? "studying" : "idle",
        lineOverride: resolveReactionLine(
          pack,
          "pet_ping",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "stats_summary":
      return {
        mood:
          event.todayReviewedCount > 0 || event.stableCount > 0
            ? "proud"
            : event.dueCount > 0
              ? "studying"
              : "idle",
        lineOverride: resolveReactionLine(
          pack,
          "stats_summary",
          {
            ...status,
            dueCount: event.dueCount,
            todayReviewedCount: event.todayReviewedCount,
            capturedLast7Days: event.capturedLast7Days,
            reviewedLast7Days: event.reviewedLast7Days,
            stableCount: event.stableCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "capture_success":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "capture_success",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "ask_ready":
      return {
        mood: "curious",
        lineOverride: resolveReactionLine(
          pack,
          "ask_ready",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "teach_success":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "teach_success",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "rescue_candidate":
      return {
        mood: "studying",
        lineOverride: resolveReactionLine(
          pack,
          "rescue_candidate",
          {
            ...status,
            recentWord: event.word,
            overdueDays: event.overdueDays
          },
          frame,
          dynamicTemplates
        )
      };
    case "rescue_complete":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "rescue_complete",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "return_after_gap":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "return_after_gap",
          {
            ...status,
            reviewedCount: event.reviewedCount,
            gapDays: event.gapDays
          },
          frame,
          dynamicTemplates
        )
      };
    case "review_next":
      return {
        mood: event.word ? "studying" : "sleepy",
        lineOverride: event.word
          ? resolveReactionLine(
              pack,
              "review_next",
              {
                ...status,
                recentWord: event.word
              },
              frame,
              dynamicTemplates
            )
          : undefined
      };
    case "review_reveal":
      return {
        mood: "curious",
        lineOverride: resolveReactionLine(
          pack,
          "review_reveal",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "review_session_complete":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "review_session_complete",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "review_session_empty":
      return {
        mood: "sleepy",
        lineOverride: resolveReactionLine(
          pack,
          "review_session_empty",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "review_session_paused":
      return {
        mood: "studying",
        lineOverride: resolveReactionLine(
          pack,
          "review_session_paused",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "review_session_quit":
      return {
        mood: event.reviewedCount > 0 ? "curious" : "sleepy",
        lineOverride: resolveReactionLine(
          pack,
          "review_session_quit",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "command_error":
      return {
        mood: "confused",
        lineOverride: resolveReactionLine(
          pack,
          "command_error",
          {
            ...status,
            errorMessage: event.errorMessage
          },
          frame,
          dynamicTemplates
        )
      };
    case "idle_prompt":
      return {
        mood: "idle",
        lineOverride: resolveReactionLine(
          pack,
          "idle_prompt",
          status,
          frame,
          dynamicTemplates
        )
      };
    case "shell_exit":
      return {
        mood: "sleepy",
        lineOverride: resolveReactionLine(
          pack,
          "shell_exit",
          {
            ...status,
            recentWord: status.recentWord
          },
          frame,
          dynamicTemplates
        )
      };
    case "re_capture_detection":
      return {
        mood: "curious",
        lineOverride: resolveReactionLine(
          pack,
          "re_capture_detection",
          {
            ...status,
            recentWord: event.word,
            encounterCount: event.encounterCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "word_stabilized":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "word_stabilized",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
    case "streak_milestone":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "streak_milestone",
          {
            ...status,
            streakDays: event.streakDays
          },
          frame,
          dynamicTemplates
        )
      };
    case "rescue_complete_counter":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "rescue_complete_counter",
          {
            ...status,
            recentWord: event.word,
            rescueCount: event.rescueCount
          },
          frame,
          dynamicTemplates
        )
      };
    case "card_created":
      return {
        mood: "proud",
        lineOverride: resolveReactionLine(
          pack,
          "card_created",
          {
            ...status,
            recentWord: event.word
          },
          frame,
          dynamicTemplates
        )
      };
  }
}
