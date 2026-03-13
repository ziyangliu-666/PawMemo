import test from "node:test";
import assert from "node:assert/strict";

import { ShellTranscriptModel } from "../src/cli/shell-transcript";

test("ShellTranscriptModel keeps active assistant content separate until commit", () => {
  const transcript = new ShellTranscriptModel();

  transcript.beginActiveAssistantCell();
  transcript.appendActiveAssistantDelta("Hello");
  transcript.appendActiveAssistantDelta(" world");

  const activeSnapshot = transcript.snapshot();
  assert.equal(activeSnapshot.committedCells.length, 0);
  assert.equal(activeSnapshot.activeCell?.text, "Hello world");

  transcript.commitActiveCell();

  const committedSnapshot = transcript.snapshot();
  assert.equal(committedSnapshot.activeCell, null);
  assert.equal(committedSnapshot.committedCells.length, 1);
  assert.equal(committedSnapshot.committedCells[0]?.kind, "assistant");
  assert.equal(committedSnapshot.committedCells[0]?.text, "Hello world");
});

test("ShellTranscriptModel trims old committed cells to the configured limit", () => {
  const transcript = new ShellTranscriptModel({ maxCommittedCells: 2 });

  transcript.appendCommittedCell("assistant", "one");
  transcript.appendCommittedCell("assistant", "two");
  transcript.appendCommittedCell("assistant", "three");

  const snapshot = transcript.snapshot();
  assert.deepEqual(
    snapshot.committedCells.map((cell) => cell.text),
    ["two", "three"]
  );
});
