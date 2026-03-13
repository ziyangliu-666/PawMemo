import test from "node:test";
import assert from "node:assert/strict";

import { loadCompanionPack } from "../src/companion/packs";
import { renderCompanionCard } from "../src/companion/presenter";

test("renderCompanionCard keeps the reaction text aligned across avatar frames", () => {
  const pack = loadCompanionPack("girlfriend");
  const first = renderCompanionCard(pack, {
    mood: "idle",
    frame: 0,
    dueCount: 2,
    recentWord: "lucid"
  }).split("\n")[1] ?? "";
  const second = renderCompanionCard(pack, {
    mood: "idle",
    frame: 1,
    dueCount: 2,
    recentWord: "lucid"
  }).split("\n")[1] ?? "";

  const firstTextIndex = first.indexOf("  ");
  const secondTextIndex = second.indexOf("  ");

  assert.equal(firstTextIndex, secondTextIndex);
  assert.match(first, /lucid|cards/);
  assert.match(second, /lucid|cards/);
});

test("renderCompanionCard wraps continuation lines from a fixed text column", () => {
  const pack = loadCompanionPack("momo");
  const rendered = renderCompanionCard(pack, {
    mood: "proud",
    frame: 0,
    dueCount: 0,
    recentWord: null,
    lineOverride: '2 cards are ready. "lucid" is near the top of the pile for tonight.'
  }).split("\n");

  const firstBodyLine = rendered[1] ?? "";
  const secondBodyLine = rendered[2] ?? "";

  assert.match(firstBodyLine, /2 cards are ready/);
  assert.match(secondBodyLine, /lucid|pile|tonight/);
  assert.equal(firstBodyLine.indexOf("2 cards"), secondBodyLine.search(/\S/));
});

test("renderCompanionCard keeps momo's idle line compact", () => {
  const pack = loadCompanionPack("momo");
  const firstBodyLine = renderCompanionCard(pack, {
    mood: "idle",
    frame: 0,
    dueCount: 0,
    recentWord: null,
    lineOverride: "Just point me at a word, and I'll trot after it."
  }).split("\n")[1] ?? "";

  assert.match(firstBodyLine, /^\(•ᴗ•\) {2}Just point me at a word/);
});
