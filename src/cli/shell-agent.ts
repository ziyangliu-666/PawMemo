import type {
  AskWordInput,
  CaptureWordInput,
  TeachWordDraftResult,
  TeachWordInput
} from "../core/domain/models";
import type {
  CompanionMood,
  CompanionPackDefinition,
  CompanionStatusSignals
} from "../companion/types";
import { ConfigurationError } from "../lib/errors";
import { interpretShellInput } from "./shell-intent";
import type { ShellPlannerTurn } from "./shell-session-state";
import type { LlmShellPlanner, ShellPlannerDecision } from "./shell-planner";

export type ShellAction =
  | { kind: "help" }
  | { kind: "quit" }
  | { kind: "pet" }
  | { kind: "stats" }
  | { kind: "rescue" }
  | { kind: "review-session" }
  | { kind: "command"; rawInput: string }
  | { kind: "ask"; input: AskWordInput }
  | { kind: "capture"; input: CaptureWordInput }
  | { kind: "teach-clarify-context"; input: TeachWordInput }
  | { kind: "teach"; input: TeachWordInput }
  | { kind: "teach-confirm"; input: TeachWordInput; draft: TeachWordDraftResult };

export interface PendingShellProposal {
  action: ShellAction;
  confirmationMessage: string;
  cancelMessage: string;
  teachDraft?: TeachWordDraftResult;
}

export type ShellAgentResponse =
  | {
      kind: "execute";
      action: ShellAction;
      source: "fast-path" | "planner";
    }
  | {
      kind: "message";
      mood: CompanionMood;
      text: string;
      source: "fast-path" | "planner";
    };

export interface ShellAgentDecision {
  response: ShellAgentResponse;
  nextPendingProposal: PendingShellProposal | null;
}

export interface ShellAgentContext {
  recentTurns: ShellPlannerTurn[];
  activePack: CompanionPackDefinition;
  statusSignals: CompanionStatusSignals;
}

function buildTeachProposal(
  input: TeachWordInput,
  confirmationMessage?: string
): PendingShellProposal {
  return {
    action: {
      kind: "teach",
      input
    },
    confirmationMessage:
      confirmationMessage ??
      `I spotted "${input.word}" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?`,
    cancelMessage: `Okay. I won't add "${input.word}" right now.`
  };
}

export class ShellConversationAgent {
  constructor(private readonly planner?: Pick<LlmShellPlanner, "plan">) {}

  async respond(
    rawInput: string,
    options: {
      pendingProposal?: PendingShellProposal | null;
      context?: ShellAgentContext;
      onPlannerMessageDelta?: (delta: string) => void | Promise<void>;
      signal?: AbortSignal;
    } = {}
  ): Promise<ShellAgentDecision> {
    const input = rawInput.trim();
    const pendingProposal = options.pendingProposal ?? null;

    if (input.length === 0) {
      return {
        response: {
          kind: "message",
          mood: "idle",
          text: "I'm here.",
          source: "fast-path"
        },
        nextPendingProposal: pendingProposal
      };
    }

    const intent = interpretShellInput(input);

    switch (intent.kind) {
      case "command":
        if (/^(?:quit|exit)\b/i.test(intent.rawInput.trim())) {
          return {
            response: {
              kind: "execute",
              action: { kind: "quit" },
              source: "fast-path"
            },
            nextPendingProposal: null
          };
        }

        return {
          response: {
            kind: "execute",
            action: {
              kind: "command",
              rawInput: intent.rawInput
            },
            source: "fast-path"
          },
          nextPendingProposal: null
        };
      case "planner":
        return this.respondWithPlanner(
          input,
          options.context,
          pendingProposal,
          options.onPlannerMessageDelta,
          options.signal
        );
    }
  }

  private async respondWithPlanner(
    rawInput: string,
    context?: ShellAgentContext,
    pendingProposal?: PendingShellProposal | null,
    onPlannerMessageDelta?: (delta: string) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<ShellAgentDecision> {
    if (!this.planner || !context) {
      throw new ConfigurationError("Shell planner is unavailable.");
    }

    const planned = await this.planner.plan({
      rawInput,
      recentTurns: context.recentTurns,
      activePack: context.activePack,
      statusSignals: context.statusSignals,
      pendingProposalText: pendingProposal?.confirmationMessage ?? null
    }, {
      onMessageDelta: onPlannerMessageDelta,
      signal
    });

    return this.mapPlannerDecision(planned, pendingProposal ?? null);
  }

  private mapPlannerDecision(
    planned: ShellPlannerDecision,
    pendingProposal: PendingShellProposal | null
  ): ShellAgentDecision {
    switch (planned.kind) {
      case "reply":
      case "clarify":
        return {
          response: {
            kind: "message",
            mood: planned.mood,
            text: planned.message,
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "confirm":
        if (!pendingProposal) {
          return {
            response: {
              kind: "message",
              mood: "confused",
              text: "There isn't anything waiting for confirmation right now.",
              source: "planner"
            },
            nextPendingProposal: null
          };
        }
        return {
          response: {
            kind: "execute",
            action: pendingProposal.action,
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "cancel":
        return {
          response: {
            kind: "message",
            mood: "idle",
            text: planned.message ?? pendingProposal?.cancelMessage ?? "Okay.",
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "help":
        return {
          response: {
            kind: "execute",
            action: { kind: "help" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "pet":
        return {
          response: {
            kind: "execute",
            action: { kind: "pet" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "stats":
        return {
          response: {
            kind: "execute",
            action: { kind: "stats" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "rescue":
        return {
          response: {
            kind: "execute",
            action: { kind: "rescue" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "review-session":
        return {
          response: {
            kind: "execute",
            action: { kind: "review-session" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "quit":
        return {
          response: {
            kind: "execute",
            action: { kind: "quit" },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "ask":
        return {
          response: {
            kind: "execute",
            action: { kind: "ask", input: planned.input },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "capture":
        return {
          response: {
            kind: "execute",
            action: { kind: "capture", input: planned.input },
            source: "planner"
          },
          nextPendingProposal: null
        };
      case "teach": {
        const proposal = buildTeachProposal(
          planned.input,
          planned.confirmationMessage
        );

        return {
          response: {
            kind: "message",
            mood: "curious",
            text: proposal.confirmationMessage,
            source: "planner"
          },
          nextPendingProposal: proposal
        };
      }
    }
  }
}

export function serializePendingShellProposal(
  proposal: PendingShellProposal
): string {
  return JSON.stringify(proposal);
}

export function deserializePendingShellProposal(
  payloadJson: string
): PendingShellProposal {
  return JSON.parse(payloadJson) as PendingShellProposal;
}
