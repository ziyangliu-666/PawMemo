import type { ConversationTurnKind } from "../core/domain/models";
import { nowIso } from "../lib/time";
import { ConversationSessionRepository } from "../storage/repositories/conversation-session-repository";
import { ConversationTurnRepository } from "../storage/repositories/conversation-turn-repository";
import { PendingConversationActionRepository } from "../storage/repositories/pending-conversation-action-repository";
import type { SqliteDatabase } from "../storage/sqlite/database";
import {
  deserializePendingShellProposal,
  type PendingShellProposal,
  serializePendingShellProposal,
  type ShellAction,
  type ShellAgentDecision
} from "./shell-agent";

function assertNever(value: never): never {
  throw new Error(`Unexpected shell action: ${JSON.stringify(value)}`);
}

function describeAction(action: ShellAction): string {
  switch (action.kind) {
    case "ask":
      return `Explain ${action.input.word}`;
    case "capture":
      return `Save ${action.input.word} with an explicit gloss`;
    case "teach":
      return `Add ${action.input.word} to the study plan`;
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

export class ShellConversationSession {
  private readonly sessions: ConversationSessionRepository;
  private readonly turns: ConversationTurnRepository;
  private readonly pendingActions: PendingConversationActionRepository;
  private readonly sessionId: number;

  constructor(
    db: SqliteDatabase,
    options: { activePackId: string; startedAt?: string }
  ) {
    this.sessions = new ConversationSessionRepository(db);
    this.turns = new ConversationTurnRepository(db);
    this.pendingActions = new PendingConversationActionRepository(db);
    this.sessionId = this.sessions.create({
      channel: "shell",
      activePackId: options.activePackId,
      startedAt: options.startedAt ?? nowIso()
    }).id;
  }

  get id(): number {
    return this.sessionId;
  }

  recordUserUtterance(text: string, createdAt = nowIso()): void {
    this.appendTurn("user", "utterance", text, null, createdAt);
  }

  applyDecision(decision: ShellAgentDecision, createdAt = nowIso()): void {
    if (decision.nextPendingProposal) {
      this.pendingActions.upsert({
        sessionId: this.sessionId,
        actionKind: decision.nextPendingProposal.action.kind,
        payloadJson: serializePendingShellProposal(decision.nextPendingProposal),
        promptText: decision.nextPendingProposal.confirmationMessage,
        createdAt,
        updatedAt: createdAt
      });
    } else {
      this.pendingActions.clear(this.sessionId);
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
    const pending = this.pendingActions.getBySession(this.sessionId);

    return pending ? deserializePendingShellProposal(pending.payloadJson) : null;
  }

  listRecentTurns(limit = 6) {
    const turns = this.turns.listBySession(this.sessionId);
    return limit > 0 ? turns.slice(-limit) : turns;
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

  end(endedAt = nowIso()): void {
    this.pendingActions.clear(this.sessionId);
    this.sessions.end(this.sessionId, endedAt);
  }

  private appendTurn(
    speaker: "user" | "assistant" | "system",
    kind: ConversationTurnKind,
    contentText: string,
    payloadJson: string | null,
    createdAt: string
  ): void {
    this.turns.append({
      sessionId: this.sessionId,
      speaker,
      kind,
      contentText,
      payloadJson,
      createdAt
    });
  }
}
