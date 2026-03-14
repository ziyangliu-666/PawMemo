import test from "node:test";
import assert from "node:assert/strict";

import {
  centerDisplayLine,
  fitComposerViewport,
  fitDisplayLine,
  tailDisplayText,
  wrapDisplayText,
  wrapDisplayTextWithPrefixes
} from "../src/lib/text-wrap";

test("wrapDisplayText prefers word boundaries when possible", () => {
  assert.deepEqual(wrapDisplayText("alpha beta gamma delta", 10), [
    "alpha beta",
    "gamma",
    "delta"
  ]);
});

test("wrapDisplayText can split a long grapheme string without breaking clusters", () => {
  assert.deepEqual(wrapDisplayText("👍🏽👍🏽👍🏽", 4), ["👍🏽", "👍🏽", "👍🏽"]);
});

test("wrapDisplayTextWithPrefixes respects the first-line and continuation widths", () => {
  assert.deepEqual(
    wrapDisplayTextWithPrefixes("alpha beta gamma delta", 10, 7),
    ["alpha beta", "gamma", "delta"]
  );
});

test("fitComposerViewport trims both sides with ellipses when content exceeds width", () => {
  assert.deepEqual(fitComposerViewport("abcdef", "ghijkl", 8), {
    before: "…f",
    after: "ghijkl"
  });
});

test("fitDisplayLine and tailDisplayText keep ellipsis semantics stable", () => {
  assert.equal(fitDisplayLine("facilitator", 6), "facil…");
  assert.equal(tailDisplayText("facilitator", 6), "…tator");
});

test("centerDisplayLine pads around the fitted content", () => {
  assert.equal(centerDisplayLine("猫", 4), " 猫 ");
});
