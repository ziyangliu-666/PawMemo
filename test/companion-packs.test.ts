import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listCompanionPacks,
  loadCompanionPack,
  renderCompanionDefaultLine,
  renderCompanionReaction
} from "../src/companion/packs";

test("built-in companion packs are available", () => {
  const packs = listCompanionPacks();

  assert.ok(packs.some((pack) => pack.id === "momo"));
  assert.ok(packs.some((pack) => pack.id === "girlfriend"));
  assert.ok(packs.some((pack) => pack.id === "tsundere"));
});

test("external companion pack json can be loaded from companions directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pawmemo-companions-"));
  const previousDir = process.env.PAWMEMO_COMPANIONS_DIR;

  try {
    const packPath = path.join(tempDir, "custom-heart.json");
    fs.writeFileSync(
      packPath,
      JSON.stringify(
        {
          id: "custom-heart",
          displayName: "Lio",
          romanceMode: "on",
          description: "A close study partner.",
          personality: "Warm and patient.",
          scenario: "Already sitting beside the learner.",
          exampleMessages: ["Stay a moment.", "We can keep going slowly."],
          postHistoryInstructions: ["Continue the current scene instead of reintroducing yourself."],
          toneRules: ["Sound intimate but calm."],
          boundaryRules: ["Do not guilt the learner."],
          moodLines: {
            idle: {
              default: ["Stay a moment."],
              withRecentWord: ['I kept "{{recentWord}}" close.']
            }
          },
          reactions: {
            pet_ping: ["Still here, darling."]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    process.env.PAWMEMO_COMPANIONS_DIR = tempDir;

    const pack = loadCompanionPack("custom-heart");
    assert.equal(pack.displayName, "Lio");
    assert.equal(pack.description, "A close study partner.");
    assert.equal(pack.personality, "Warm and patient.");
    assert.equal(pack.scenario, "Already sitting beside the learner.");
    assert.deepEqual(pack.exampleMessages, ["Stay a moment.", "We can keep going slowly."]);
    assert.deepEqual(pack.postHistoryInstructions, [
      "Continue the current scene instead of reintroducing yourself."
    ]);
    assert.deepEqual(pack.toneRules, ["Sound intimate but calm."]);
    assert.deepEqual(pack.boundaryRules, ["Do not guilt the learner."]);
    assert.equal(
      renderCompanionDefaultLine(
        pack,
        "idle",
        {
          recentWord: "luminous"
        },
        0
      ),
      'I kept "luminous" close.'
    );
    assert.equal(
      renderCompanionReaction(pack, "pet_ping", {}, 0),
      "Still here, darling."
    );
    assert.equal(pack.avatarFrames, undefined);
  } finally {
    if (previousDir === undefined) {
      delete process.env.PAWMEMO_COMPANIONS_DIR;
    } else {
      process.env.PAWMEMO_COMPANIONS_DIR = previousDir;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
