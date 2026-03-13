import test from "node:test";
import assert from "node:assert/strict";

import { parseCommand, tokenizeCommandLine } from "../src/cli/command-parser";

test("tokenizeCommandLine preserves quoted flag values for shell input", () => {
  const tokens = tokenizeCommandLine(
    'capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"'
  );

  assert.deepEqual(tokens, [
    "capture",
    "luminous",
    "--ctx",
    "The jellyfish gave off a luminous glow.",
    "--gloss",
    "emitting light"
  ]);
});

test("parseCommand separates args and flags after tokenization", () => {
  const command = parseCommand(
    tokenizeCommandLine('ask lucid --ctx "Her explanation was lucid and easy to follow."')
  );

  assert.equal(command.name, "ask");
  assert.deepEqual(command.args, ["lucid"]);
  assert.equal(
    command.flags.ctx,
    "Her explanation was lucid and easy to follow."
  );
});

test("parseCommand accepts registered boolean flags without a value", () => {
  const command = parseCommand(["shell", "--tui"]);

  assert.equal(command.name, "shell");
  assert.equal(command.flags.tui, "true");
});
