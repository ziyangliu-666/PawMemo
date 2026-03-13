import test from "node:test";
import assert from "node:assert/strict";

import { createCliTheme } from "../src/cli/theme";

test("createCliTheme leaves non-colored output untouched when disabled", () => {
  const theme = createCliTheme({ enabled: false });

  assert.equal(theme.prompt("paw> "), "paw> ");
  assert.equal(theme.dataBlock("Word: lucid", "ask-result"), "Word: lucid");
  assert.equal(theme.companionLine("Still here."), "Still here.");
});

test("createCliTheme adds ANSI styling when enabled", () => {
  const theme = createCliTheme({ enabled: true });
  const prompt = theme.prompt("paw> ");
  const companion = theme.companionCard("[ Momo · loyal ]\nU•ᴥ•U  Still here.");
  const data = theme.dataBlock(
    "Word: lucid\nGloss: emitting light",
    "ask-result"
  );

  assert.ok(prompt.includes("\u001b["), "expected ANSI prompt styling");
  assert.ok(companion.includes("\u001b["), "expected ANSI companion styling");
  assert.ok(companion.includes("[ Momo · loyal ]"));
  assert.ok(data.includes("\u001b["), "expected ANSI data styling");
  assert.ok(data.includes("Word:"));
  assert.ok(data.includes("Gloss:"));
});
