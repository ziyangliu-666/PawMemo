import test from "node:test";
import assert from "node:assert/strict";

import { interpretShellInput } from "../src/cli/shell-intent";

test("interpretShellInput keeps slash-prefixed shell commands as command mode", () => {
  const intent = interpretShellInput("/help");

  assert.deepEqual(intent, {
    kind: "command",
    rawInput: "help"
  });
});

test("interpretShellInput sends all non-slash input to the planner", () => {
  const intent = interpretShellInput("你好呀 我我");

  assert.deepEqual(intent, {
    kind: "planner",
    text: "你好呀 我我"
  });
});
