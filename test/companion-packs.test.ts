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
          avatarFrames: {
            idle: ["[o_o]", "[>_<]"]
          },
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
  } finally {
    if (previousDir === undefined) {
      delete process.env.PAWMEMO_COMPANIONS_DIR;
    } else {
      process.env.PAWMEMO_COMPANIONS_DIR = previousDir;
    }

    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
