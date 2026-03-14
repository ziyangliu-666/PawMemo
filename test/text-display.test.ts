import test from "node:test";
import assert from "node:assert/strict";

import {
  clampToNearestGraphemeBoundary,
  composerDisplayText,
  nextGraphemeBoundary,
  normalizePastedText,
  previousGraphemeBoundary,
  splitGraphemes,
  stringDisplayWidth,
  takeLeadingInputToken,
  visibleDisplayWidth
} from "../src/lib/text-display";

test("splitGraphemes keeps emoji modifier sequences intact", () => {
  assert.deepEqual(splitGraphemes("A👍🏽B"), ["A", "👍🏽", "B"]);
});

test("grapheme boundary helpers move across full grapheme clusters", () => {
  const text = "A👍🏽B";
  const cursorInsideEmoji = 3;

  assert.equal(clampToNearestGraphemeBoundary(text, cursorInsideEmoji), 1);
  assert.equal(previousGraphemeBoundary(text, text.length - 1), 1);
  assert.equal(nextGraphemeBoundary(text, 1), 5);
});

test("stringDisplayWidth counts CJK and emoji as double-width", () => {
  assert.equal(stringDisplayWidth("猫a"), 3);
  assert.equal(stringDisplayWidth("👍🏽"), 4);
});

test("visibleDisplayWidth ignores ANSI color escapes", () => {
  assert.equal(visibleDisplayWidth("\u001b[97mHi猫\u001b[0m"), 4);
});

test("takeLeadingInputToken returns control bytes and grapheme clusters intact", () => {
  assert.equal(takeLeadingInputToken("\rrest"), "\r");
  assert.equal(takeLeadingInputToken("👍🏽rest"), "👍🏽");
});

test("normalizePastedText and composerDisplayText normalize composer-facing text", () => {
  assert.equal(normalizePastedText("第一行\r\n第二行\r第三行"), "第一行\n第二行\n第三行");
  assert.equal(composerDisplayText("a\tb\nc"), "a  b⏎c");
});
