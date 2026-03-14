import test from "node:test";
import assert from "node:assert/strict";

import { ShellSessionState } from "../src/cli/shell-session-state";

test("ShellSessionState keeps pending proposals and recent turns in memory", () => {
  const state = new ShellSessionState();

  state.recordUserUtterance("加入 luminous", "2026-03-12T00:00:01.000Z");
  state.applyDecision(
    {
      response: {
        kind: "message",
        mood: "curious",
        text: 'I spotted "luminous" as a word to learn. Do you want me to add it?',
        source: "planner"
      },
      nextPendingProposal: {
        action: {
          kind: "teach",
          input: {
            word: "luminous",
            context: "加入 luminous"
          }
        },
        confirmationMessage:
          'I spotted "luminous" as a word to learn. Do you want me to add it?',
        cancelMessage: 'Okay. I won\'t add "luminous" right now.'
      }
    },
    "2026-03-12T00:00:02.000Z"
  );
  state.recordActionResult(
    'I taught "luminous" as "emitting light".',
    JSON.stringify({ type: "teach" }),
    "2026-03-12T00:00:03.000Z"
  );

  assert.equal(state.getPendingProposal()?.action.kind, "teach");
  assert.deepEqual(
    state.listRecentTurns(3).map((turn) => ({
      speaker: turn.speaker,
      kind: turn.kind,
      text: turn.contentText
    })),
    [
      {
        speaker: "user",
        kind: "utterance",
        text: "加入 luminous"
      },
      {
        speaker: "assistant",
        kind: "proposal",
        text: 'I spotted "luminous" as a word to learn. Do you want me to add it?'
      },
      {
        speaker: "assistant",
        kind: "result",
        text: 'I taught "luminous" as "emitting light".'
      }
    ]
  );
});

test("ShellSessionState clears an invalid pending proposal instead of crashing later", () => {
  const state = new ShellSessionState() as ShellSessionState & {
    getPendingProposal(): ReturnType<ShellSessionState["getPendingProposal"]>;
  };
  const internalState = state as unknown as {
    pendingProposalJson: string | null;
  };

  internalState.pendingProposalJson = JSON.stringify({
    action: {
      kind: "teach"
    },
    confirmationMessage: "confirm",
    cancelMessage: "cancel"
  });

  assert.equal(state.getPendingProposal(), null);
  assert.equal(state.getPendingProposal(), null);
});
