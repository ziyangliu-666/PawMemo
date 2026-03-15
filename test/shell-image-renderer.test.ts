import test from "node:test";
import assert from "node:assert/strict";

import { renderShellSnapshotToPng } from "../src/cli/shell-image-renderer";
import type { ShellHarnessSnapshot } from "../src/cli/shell-harness";

function buildSnapshot(styledLine: string): ShellHarnessSnapshot {
  return {
    sessionId: "session-1",
    snapshotId: "snap-1",
    createdAt: "2026-03-15T00:00:00.000Z",
    promptPending: true,
    frame: {
      displayName: "Momo",
      shellMode: "Chat",
      dueCount: 0,
      viewport: {
        columns: 12,
        rows: 1
      },
      transcript: {
        committedCells: [],
        activeCell: null
      },
      waiting: null,
      companionLine: null,
      interruptHint: null,
      composer: {
        promptLabel: "› ",
        buffer: "",
        cursorIndex: 0,
        promptArmed: true,
        promptEpoch: 1,
        inlineInputEnabled: true,
        slashSuggestions: [],
        selectionPrompt: null,
        exitConfirmPending: false
      },
      layout: {
        header: {
          top: 0,
          height: 0,
          lines: []
        },
        tip: {
          top: 0,
          height: 0,
          lines: []
        },
        transcript: {
          top: 0,
          height: 1,
          lines: ["Hello"]
        },
        status: {
          top: 0,
          height: 0,
          lines: []
        },
        composer: {
          top: 0,
          height: 0,
          lines: []
        },
        footer: {
          top: 0,
          height: 0,
          lines: []
        }
      },
      rendered: {
        lines: ["Hello"],
        frameText: "Hello",
        styledLines: [styledLine],
        cursor: null
      }
    }
  };
}

test("renderShellSnapshotToPng ignores non-SGR CSI control sequences like erase-line", () => {
  const clean = renderShellSnapshotToPng(buildSnapshot("Hello"));
  const withEraseLine = renderShellSnapshotToPng(buildSnapshot("Hello\u001b[K"));

  assert.ok(
    clean.equals(withEraseLine),
    "expected non-visual CSI sequences to be ignored during PNG rendering"
  );
});
