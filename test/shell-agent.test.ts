import test from "node:test";
import assert from "node:assert/strict";

import { ShellConversationAgent } from "../src/cli/shell-agent";
import { deserializePendingShellProposal } from "../src/cli/shell-contract";

const plannerContext = {
  recentTurns: [],
  activePack: {
    id: "momo",
    displayName: "Momo",
    romanceMode: "off" as const,
    description: "A loyal study dog.",
    personality: "Calm and eager to help.",
    scenario: "Already sharing the study nook.",
    exampleMessages: ["I'm here with the word pile."],
    postHistoryInstructions: ["Stay in the current scene after reading history."],
    toneRules: ["Sound warm and steady."],
    boundaryRules: ["Do not overshadow study help."],
    avatarFrames: {},
    moodLines: {},
    reactions: {}
  },
  statusSignals: {
    dueCount: 0,
    recentWord: null
  }
};

test("ShellConversationAgent routes non-slash save intent through the planner", async () => {
  let plannerCalls = 0;
  const agent = new ShellConversationAgent({
    async plan() {
      plannerCalls += 1;
      return {
        kind: "teach",
        input: {
          word: "luminous",
          context: "加入 luminous"
        },
        confirmationMessage: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?'
      };
    }
  });

  const first = await agent.respond("加入 luminous", {
    context: plannerContext
  });

  assert.equal(plannerCalls, 1);
  assert.deepEqual(first, {
    response: {
      kind: "message",
      mood: "curious",
      text: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
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
      confirmationMessage: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
      cancelMessage: 'Okay. I won\'t add "luminous" right now.'
    }
  });
});

test("ShellConversationAgent routes pending confirmation through the planner", async () => {
  let plannerCalls = 0;
  const agent = new ShellConversationAgent({
    async plan() {
      plannerCalls += 1;
      return {
        kind: "confirm"
      };
    }
  });

  const response = await agent.respond("yes", {
    context: plannerContext,
    pendingProposal: {
      action: {
        kind: "teach",
        input: {
          word: "luminous",
          context: "加入 luminous"
        }
      },
      confirmationMessage: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
      cancelMessage: 'Okay. I won\'t add "luminous" right now.'
    }
  });

  assert.equal(plannerCalls, 1);
  assert.deepEqual(response, {
    response: {
      kind: "execute",
      action: {
        kind: "teach",
        input: {
          word: "luminous",
          context: "加入 luminous"
        }
      },
      source: "planner"
    },
    nextPendingProposal: null
  });
});

test("ShellConversationAgent routes pending cancellation through the planner", async () => {
  const agent = new ShellConversationAgent({
    async plan() {
      return {
        kind: "cancel",
        message: 'Okay. I won\'t add "luminous" right now.'
      };
    }
  });

  const response = await agent.respond("不要", {
    context: plannerContext,
    pendingProposal: {
      action: {
        kind: "teach",
        input: {
          word: "luminous",
          context: "加入 luminous"
        }
      },
      confirmationMessage: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
      cancelMessage: 'Okay. I won\'t add "luminous" right now.'
    }
  });

  assert.deepEqual(response, {
    response: {
      kind: "message",
      mood: "idle",
      text: 'Okay. I won\'t add "luminous" right now.',
      source: "planner"
    },
    nextPendingProposal: null
  });
});

test("ShellConversationAgent sends greetings through the planner instead of local heuristics", async () => {
  let plannerCalls = 0;
  const agent = new ShellConversationAgent({
    async plan() {
      plannerCalls += 1;
      return {
        kind: "reply",
        mood: "curious",
        message: "你好。我在这儿。"
      };
    }
  });

  const response = await agent.respond("你好呀", {
    context: plannerContext
  });

  assert.equal(plannerCalls, 1);
  assert.deepEqual(response, {
    response: {
      kind: "message",
      mood: "curious",
      text: "你好。我在这儿。",
      source: "planner"
    },
    nextPendingProposal: null
  });
});

test("ShellConversationAgent routes rescue intent through the planner", async () => {
  const agent = new ShellConversationAgent({
    async plan() {
      return {
        kind: "rescue"
      };
    }
  });

  const response = await agent.respond("救一下", {
    context: plannerContext
  });

  assert.deepEqual(response, {
    response: {
      kind: "execute",
      action: {
        kind: "rescue"
      },
      source: "planner"
    },
    nextPendingProposal: null
  });
});

test("ShellConversationAgent keeps slash commands on the local fast path", async () => {
  let plannerCalls = 0;
  const agent = new ShellConversationAgent({
    async plan() {
      plannerCalls += 1;
      return {
        kind: "reply",
        mood: "curious",
        message: "should not run"
      };
    }
  });

  const response = await agent.respond("/help", {
    context: plannerContext
  });

  assert.equal(plannerCalls, 0);
  assert.deepEqual(response, {
    response: {
      kind: "execute",
      action: {
        kind: "command",
        rawInput: "help"
      },
      source: "fast-path"
    },
    nextPendingProposal: null
  });
});

test("deserializePendingShellProposal rejects unsupported action kinds", () => {
  assert.throws(
    () =>
      deserializePendingShellProposal(
        JSON.stringify({
          action: { kind: "stats" },
          confirmationMessage: "confirm",
          cancelMessage: "cancel"
        })
      ),
    /unsupported action kind/i
  );
});
