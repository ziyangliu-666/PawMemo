import { nowIso } from "../lib/time";
import {
  deserializePendingShellProposal,
  serializePendingShellProposal,
  type PendingShellProposal,
  type ShellAction,
  type ShellAgentDecision
} from "./shell-agent";

export type ShellTurnSpeaker = "user" | "assistant";

export type ShellTurnKind =
  | "utterance"
  | "message"
  | "proposal"
  | "action"
  | "result"
  | "error";

export interface ShellPlannerTurn {
  speaker: ShellTurnSpeaker;
  kind: ShellTurnKind;
  contentText: string;
  createdAt: string;
  payloadJson: string | null;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected shell action: ${JSON.stringify(value)}`);
}

function describeAction(action: ShellAction): string {
  switch (action.kind) {
    case "ask":
      return `Explain ${action.input.word}`;
    case "capture":
      return `Save ${action.input.word} with an explicit gloss`;
    case "teach-clarify-context":
      return `Clarify how to build a card for ${action.input.word}`;
    case "teach":
      return `Add ${action.input.word} to the study plan`;
    case "teach-confirm":
      return `Confirm drafted card for ${action.input.word}`;
    case "review-session":
      return "Start review";
    case "rescue":
      return "Start rescue";
    case "stats":
      return "Show study progress";
    case "pet":
      return "Check in with the companion";
    case "help":
      return "Show shell help";
    case "quit":
      return "Leave the shell";
    case "command":
      return `Run command: ${action.rawInput}`;
  }

  return assertNever(action);
}

export class ShellSessionState {
  private readonly turns: ShellPlannerTurn[] = [];
  private pendingProposalJson: string | null = null;

  recordUserUtterance(text: string, createdAt = nowIso()): void {
    this.appendTurn("user", "utterance", text, null, createdAt);
  }

  applyDecision(decision: ShellAgentDecision, createdAt = nowIso()): void {
    if (decision.nextPendingProposal) {
      this.pendingProposalJson = serializePendingShellProposal(
        decision.nextPendingProposal
      );
    } else {
      this.pendingProposalJson = null;
    }

    if (decision.response.kind === "message") {
      const payloadJson = decision.nextPendingProposal
        ? JSON.stringify({
            source: decision.response.source,
            proposal: decision.nextPendingProposal
          })
        : JSON.stringify({
            source: decision.response.source
          });

      this.appendTurn(
        "assistant",
        decision.nextPendingProposal ? "proposal" : "message",
        decision.response.text,
        payloadJson,
        createdAt
      );
      return;
    }

    this.appendTurn(
      "assistant",
      "action",
      describeAction(decision.response.action),
      JSON.stringify({
        source: decision.response.source,
        action: decision.response.action
      }),
      createdAt
    );
  }

  getPendingProposal(): PendingShellProposal | null {
    return this.pendingProposalJson
      ? deserializePendingShellProposal(this.pendingProposalJson)
      : null;
  }

  listRecentTurns(limit = 6): ShellPlannerTurn[] {
    return limit > 0 ? this.turns.slice(-limit) : [...this.turns];
  }

  recordActionResult(
    text: string,
    payloadJson: string | null = null,
    createdAt = nowIso()
  ): void {
    this.appendTurn("assistant", "result", text, payloadJson, createdAt);
  }

  recordError(text: string, createdAt = nowIso()): void {
    this.appendTurn("assistant", "error", text, null, createdAt);
  }

  private appendTurn(
    speaker: ShellTurnSpeaker,
    kind: ShellTurnKind,
    contentText: string,
    payloadJson: string | null,
    createdAt: string
  ): void {
    this.turns.push({
      speaker,
      kind,
      contentText,
      payloadJson,
      createdAt
    });
  }
}
