import test from "node:test";
import assert from "node:assert/strict";

import { loadCompanionPack } from "../src/companion/packs";
import { buildCompanionReaction } from "../src/companion/reaction-builder";

test("buildCompanionReaction maps review session completion into a proud pack-specific line", () => {
  const pack = loadCompanionPack("momo");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "review_session_complete",
      reviewedCount: 3
    },
    {
      dueCount: 0,
      recentWord: "luminous"
    },
    0
  );

  assert.equal(reaction.mood, "proud");
  assert.match(reaction.lineOverride ?? "", /3 cards/);
});

test("buildCompanionReaction uses review_next event data for pack-specific wording", () => {
  const pack = loadCompanionPack("tsundere");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "review_next",
      word: "lucid"
    },
    {
      dueCount: 2,
      recentWord: "lucid"
    },
    0
  );

  assert.equal(reaction.mood, "studying");
  assert.match(reaction.lineOverride ?? "", /lucid/);
});

test("buildCompanionReaction maps stats summary into a proud line when progress exists", () => {
  const pack = loadCompanionPack("girlfriend");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "stats_summary",
      todayReviewedCount: 4,
      dueCount: 2,
      capturedLast7Days: 3,
      reviewedLast7Days: 9,
      stableCount: 1
    },
    {
      dueCount: 2,
      recentWord: "lucid"
    },
    0
  );

  assert.equal(reaction.mood, "proud");
  assert.match(reaction.lineOverride ?? "", /4 cards today/);
  assert.match(reaction.lineOverride ?? "", /1 word feel steady|1 word is stable|1 word/);
});

test("buildCompanionReaction maps rescue completion into a proud pack-specific line", () => {
  const pack = loadCompanionPack("momo");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "rescue_complete",
      word: "luminous"
    },
    {
      dueCount: 1,
      recentWord: "luminous"
    },
    0
  );

  assert.equal(reaction.mood, "proud");
  assert.match(reaction.lineOverride ?? "", /luminous/i);
});

test("buildCompanionReaction maps return-after-gap into a gap-aware pack-specific line", () => {
  const pack = loadCompanionPack("girlfriend");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "return_after_gap",
      reviewedCount: 2,
      gapDays: 11
    },
    {
      dueCount: 3,
      recentWord: "luminous"
    },
    0
  );

  assert.equal(reaction.mood, "proud");
  assert.match(reaction.lineOverride ?? "", /11 day/i);
  assert.match(reaction.lineOverride ?? "", /2 cards/i);
});

test("buildCompanionReaction prefers dynamic voice-bank templates when present", () => {
  const pack = loadCompanionPack("girlfriend");
  const reaction = buildCompanionReaction(
    pack,
    {
      type: "stats_summary",
      todayReviewedCount: 4,
      dueCount: 2,
      capturedLast7Days: 3,
      reviewedLast7Days: 9,
      stableCount: 1
    },
    {
      dueCount: 2,
      recentWord: "lucid"
    },
    0,
    {
      stats_summary:
        'I saw you move {{todayReviewedCount}} cards today, and {{stableCount}} word is finally settling.'
    }
  );

  assert.equal(reaction.mood, "proud");
  assert.equal(
    reaction.lineOverride,
    "I saw you move 4 cards today, and 1 word is finally settling."
  );
});
