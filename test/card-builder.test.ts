import test from "node:test";
import assert from "node:assert/strict";

import { buildCardSeeds } from "../src/review/card-builder";

test("buildCardSeeds creates recognition and cloze cards deterministically", () => {
  const cards = buildCardSeeds({
    word: "luminous",
    context: "The jellyfish gave off a luminous glow.",
    gloss: "emitting light"
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((card) => card.cardType),
    ["recognition", "cloze"]
  );
  assert.equal(
    cards[0].promptText,
    'What does "luminous" mean in this context?\nThe jellyfish gave off a luminous glow.'
  );
  assert.equal(cards[0].answerText, "emitting light");
  assert.match(cards[1].promptText, /____ glow\.$/);
  assert.equal(cards[1].answerText, "luminous\nMeaning: emitting light");
});

test("buildCardSeeds prefers an authored cloze context when provided", () => {
  const cards = buildCardSeeds({
    word: "facilitator",
    context: "The facilitator kept the discussion moving smoothly.",
    gloss: "someone who makes a process easier",
    clozeContext: "The ____ kept the discussion moving smoothly."
  });

  assert.equal(
    cards[1].promptText,
    "Fill the missing word.\nThe ____ kept the discussion moving smoothly."
  );
});

test("buildCardSeeds can render prompt shells in Chinese", () => {
  const cards = buildCardSeeds({
    word: "lucid",
    context: "Her explanation was lucid and easy to follow.",
    gloss: "清晰易懂的",
    promptLanguage: "zh",
    clozeContext: "Her explanation was ____ and easy to follow."
  });

  assert.equal(
    cards[0].promptText,
    "这里的“lucid”是什么意思？\nHer explanation was lucid and easy to follow."
  );
  assert.equal(cards[1].promptText, "填空。\nHer explanation was ____ and easy to follow.");
  assert.equal(cards[1].answerText, "lucid\n意思：清晰易懂的");
});

test("buildCardSeeds can keep only the requested card types", () => {
  const cards = buildCardSeeds({
    word: "spire",
    context: "Spire means 尖塔.",
    gloss: "尖塔",
    cardTypes: ["cloze"]
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.cardType, "cloze");
  assert.equal(cards[0]?.promptText, "Fill the missing word.\n____ means 尖塔.");
});
