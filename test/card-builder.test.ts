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
