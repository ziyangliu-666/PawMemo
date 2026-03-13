import { renderCompanionReaction } from "./packs";
import type {
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

export function buildCompanionReaction(
  pack: CompanionPackDefinition,
  event: CompanionEvent,
  status: CompanionStatusSignals,
  frame: number
): CompanionReactionResult {
  switch (event.type) {
    case "status_snapshot":
      return {
        mood: status.dueCount > 0 ? "studying" : status.recentWord ? "idle" : "sleepy"
      };
    case "planner_wait":
      return {
        mood: "curious",
        lineOverride: resolveReaction(pack, "planner_wait", status, frame)
      };
    case "study_wait":
      return {
        mood: "studying",
        lineOverride: resolveReaction(pack, "study_wait", status, frame)
      };
    case "help":
      return {
        mood: "idle",
        lineOverride: resolveReaction(pack, "help", status, frame)
      };
    case "pet_ping":
      return {
        mood: status.dueCount > 0 ? "studying" : "idle",
        lineOverride: resolveReaction(pack, "pet_ping", status, frame)
      };
    case "stats_summary":
      return {
        mood:
          event.todayReviewedCount > 0 || event.stableCount > 0
            ? "proud"
            : event.dueCount > 0
              ? "studying"
              : "idle",
        lineOverride: resolveReaction(
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
          frame
        )
      };
    case "capture_success":
      return {
        mood: "proud",
        lineOverride: resolveReaction(
          pack,
          "capture_success",
          {
            ...status,
            recentWord: event.word
          },
          frame
        )
      };
    case "ask_ready":
      return {
        mood: "curious",
        lineOverride: resolveReaction(
          pack,
          "ask_ready",
          {
            ...status,
            recentWord: event.word
          },
          frame
        )
      };
    case "teach_success":
      return {
        mood: "proud",
        lineOverride: resolveReaction(
          pack,
          "teach_success",
          {
            ...status,
            recentWord: event.word
          },
          frame
        )
      };
    case "rescue_candidate":
      return {
        mood: "studying",
        lineOverride: resolveReaction(
          pack,
          "rescue_candidate",
          {
            ...status,
            recentWord: event.word,
            overdueDays: event.overdueDays
          },
          frame
        )
      };
    case "rescue_complete":
      return {
        mood: "proud",
        lineOverride: resolveReaction(
          pack,
          "rescue_complete",
          {
            ...status,
            recentWord: event.word
          },
          frame
        )
      };
    case "return_after_gap":
      return {
        mood: "proud",
        lineOverride: resolveReaction(
          pack,
          "return_after_gap",
          {
            ...status,
            reviewedCount: event.reviewedCount,
            gapDays: event.gapDays
          },
          frame
        )
      };
    case "review_next":
      return {
        mood: event.word ? "studying" : "sleepy",
        lineOverride: event.word
          ? resolveReaction(
              pack,
              "review_next",
              {
                ...status,
                recentWord: event.word
              },
              frame
            )
          : undefined
      };
    case "review_reveal":
      return {
        mood: "curious",
        lineOverride: resolveReaction(
          pack,
          "review_reveal",
          {
            ...status,
            recentWord: event.word
          },
          frame
        )
      };
    case "review_session_complete":
      return {
        mood: "proud",
        lineOverride: resolveReaction(
          pack,
          "review_session_complete",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame
        )
      };
    case "review_session_empty":
      return {
        mood: "sleepy",
        lineOverride: resolveReaction(pack, "review_session_empty", status, frame)
      };
    case "review_session_paused":
      return {
        mood: "studying",
        lineOverride: resolveReaction(
          pack,
          "review_session_paused",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame
        )
      };
    case "review_session_quit":
      return {
        mood: event.reviewedCount > 0 ? "curious" : "sleepy",
        lineOverride: resolveReaction(
          pack,
          "review_session_quit",
          {
            ...status,
            reviewedCount: event.reviewedCount
          },
          frame
        )
      };
    case "command_error":
      return {
        mood: "confused",
        lineOverride: resolveReaction(
          pack,
          "command_error",
          {
            ...status,
            errorMessage: event.errorMessage
          },
          frame
        )
      };
    case "idle_prompt":
      return {
        mood: "idle",
        lineOverride: resolveReaction(pack, "idle_prompt", status, frame)
      };
    case "shell_exit":
      return {
        mood: "sleepy",
        lineOverride: resolveReaction(pack, "shell_exit", status, frame)
      };
  }
}
