import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ShellConversationSession } from "../src/cli/shell-conversation-session";
import { openDatabase } from "../src/storage/sqlite/database";

function tempDbPath(name: string): string {
  return path.join(os.tmpdir(), `pawmemo-${name}-${Date.now()}-${Math.random()}.db`);
}

test("ShellConversationSession persists pending proposals and turn history", () => {
  const dbPath = tempDbPath("shell-conversation");
  const db = openDatabase(dbPath);

  try {
    const session = new ShellConversationSession(db, {
      activePackId: "momo",
      startedAt: "2026-03-12T00:00:00.000Z"
    });

    session.recordUserUtterance("加入 luminous", "2026-03-12T00:00:01.000Z");
    session.applyDecision(
      {
        response: {
          kind: "message",
          mood: "curious",
          text: 'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
          source: "fast-path"
        },
        nextPendingProposal: {
          action: {
            kind: "teach",
            input: {
              word: "luminous",
              context: "加入 luminous"
            }
          },
          confirmationMessage:
            'I spotted "luminous" as a word to learn. Do you want me to add it to your study plan and infer a gloss first?',
          cancelMessage: 'Okay. I won\'t add "luminous" right now.'
        }
      },
      "2026-03-12T00:00:02.000Z"
    );

    const pending = session.getPendingProposal();

    assert.ok(pending);
    assert.equal(pending?.action.kind, "teach");

    const turns = db.prepare(
      `
        SELECT speaker, kind, content_text
        FROM conversation_turns
        WHERE session_id = ?
        ORDER BY turn_index ASC
      `
    ).all(session.id) as Array<Record<string, unknown>>;

    assert.deepEqual(
      turns.map((turn) => ({
        speaker: turn.speaker,
        kind: turn.kind
      })),
      [
        { speaker: "user", kind: "utterance" },
        { speaker: "assistant", kind: "proposal" }
      ]
    );
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});
