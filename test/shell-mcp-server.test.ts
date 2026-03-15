import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { PawMemoShellMcpController } from "../src/cli/shell-mcp-server";

test("PawMemoShellMcpController exposes MCP runtime freshness through a tool and resource", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const status = await controller.callTool("server_status", {}) as {
    processId: number;
    server: {
      name: string;
    };
    dist: {
      rootPath: string;
      latestPath: string | null;
      changedSinceLaunch: boolean;
    };
    freshness: {
      isStale: boolean;
      hint: string;
    };
  };

  assert.equal(status.server.name, "pawmemo-shell");
  assert.equal(status.processId, process.pid);
  assert.ok(status.dist.rootPath.includes(path.join("PawMemo", "dist")));
  assert.equal(typeof status.dist.changedSinceLaunch, "boolean");
  assert.equal(typeof status.freshness.isStale, "boolean");
  assert.match(status.freshness.hint, /MCP process/i);

  const resources = controller.listResources();
  assert.ok(resources.some((resource) => resource.uri === "pawmemo://server"));

  const resource = controller.readResource("pawmemo://server") as {
    contents: Array<{
      mimeType: string;
      text: string;
    }>;
  };
  assert.equal(resource.contents[0]?.mimeType, "application/json");
  assert.match(resource.contents[0]?.text ?? "", /"processId":/);
  assert.match(resource.contents[0]?.text ?? "", /"freshness":/);
});

test("PawMemoShellMcpController can start, snapshot, resize, and stop a shell session", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 72,
    rows: 20
  }) as {
    sessionId: string;
    frame: {
      viewport: {
        columns: number;
        rows: number;
      };
      rendered: {
        frameText: string;
      };
    };
  };

  assert.match(started.sessionId, /-/);
  assert.equal(started.frame.viewport.columns, 72);
  assert.equal(started.frame.viewport.rows, 20);
  assert.match(started.frame.rendered.frameText, /starting fresh/i);

  const snapshot = await controller.callTool("shell_snapshot", {
    sessionId: started.sessionId
  }) as {
    frame: {
      viewport: {
        columns: number;
      };
    };
  };

  assert.equal(snapshot.frame.viewport.columns, 72);

  const resized = await controller.callTool("shell_resize", {
    sessionId: started.sessionId,
    columns: 90,
    rows: 28
  }) as {
    frame: {
      viewport: {
        columns: number;
        rows: number;
      };
    };
  };

  assert.equal(resized.frame.viewport.columns, 90);
  assert.equal(resized.frame.viewport.rows, 28);

  const stopped = await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  }) as {
    stopped: boolean;
  };

  assert.equal(stopped.stopped, true);
});

test("PawMemoShellMcpController supports type, key, diff, and export on a shell session", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 80,
    rows: 24
  }) as {
    sessionId: string;
    snapshotId: string;
  };

  const typed = await controller.callTool("shell_type", {
    sessionId: started.sessionId,
    text: "/he"
  }) as {
    snapshotId: string;
    frame: {
      composer: {
        buffer: string;
        slashSuggestions: Array<{
          command: string;
        }>;
      };
    };
  };

  assert.equal(typed.frame.composer.buffer, "/he");
  assert.ok(
    typed.frame.composer.slashSuggestions.some((entry) => entry.command === "/help")
  );

  const moved = await controller.callTool("shell_key", {
    sessionId: started.sessionId,
    key: "left"
  }) as {
    snapshotId: string;
    frame: {
      composer: {
        cursorIndex: number;
      };
    };
  };

  assert.ok(moved.frame.composer.cursorIndex < 3);

  const diff = await controller.callTool("shell_diff", {
    sessionId: started.sessionId,
    fromSnapshotId: started.snapshotId,
    toSnapshotId: typed.snapshotId
  }) as {
    changedRegions: Array<{
      region: string;
    }>;
  };

  assert.ok(diff.changedRegions.some((region) => region.region === "composer"));

  const exportPath = path.join(
    os.tmpdir(),
    `pawmemo-shell-${Date.now()}.svg`
  );
  const exported = await controller.callTool("shell_export", {
    sessionId: started.sessionId,
    format: "svg",
    outputPath: exportPath
  }) as {
    path: string;
  };

  assert.equal(exported.path, exportPath);
  assert.ok(fs.existsSync(exportPath));

  const pngExportPath = path.join(
    os.tmpdir(),
    `pawmemo-shell-${Date.now()}.png`
  );
  const exportedPng = await controller.callTool("shell_export", {
    sessionId: started.sessionId,
    format: "png",
    outputPath: pngExportPath
  }) as {
    path: string;
  };

  assert.equal(exportedPng.path, pngExportPath);
  assert.ok(fs.existsSync(pngExportPath));
  assert.deepEqual(
    [...fs.readFileSync(pngExportPath).subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  );

  await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  });
});

test("PawMemoShellMcpController waits cleanly for fast synchronous prompt cycles", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 80,
    rows: 24
  }) as {
    sessionId: string;
  };

  const submitted = await controller.callTool("shell_submit", {
    sessionId: started.sessionId,
    input: "/help"
  }) as {
    frame: {
      composer: {
        promptArmed: boolean;
      };
      transcript: {
        committedCells: Array<{
          text: string;
        }>;
      };
    };
  };

  assert.equal(submitted.frame.composer.promptArmed, true);
  assert.ok(
    submitted.frame.transcript.committedCells.some((cell) =>
      cell.text.includes("Natural input:")
    )
  );

  await controller.callTool("shell_type", {
    sessionId: started.sessionId,
    text: "/help "
  });

  const keyed = await controller.callTool("shell_key", {
    sessionId: started.sessionId,
    key: "submit",
    waitForPrompt: true
  }) as {
    frame: {
      composer: {
        promptArmed: boolean;
      };
      transcript: {
        committedCells: Array<{
          text: string;
        }>;
      };
    };
  };

  assert.equal(keyed.frame.composer.promptArmed, true);
  assert.ok(
    keyed.frame.transcript.committedCells.some((cell) =>
      cell.text.includes("Natural input:")
    )
  );

  await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  });
});

test("PawMemoShellMcpController clears stale footer error copy before the next study flow", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 100,
    rows: 30
  }) as {
    sessionId: string;
  };

  await controller.callTool("shell_submit", {
    sessionId: started.sessionId,
    input: '/capture luminous --ctx "The jellyfish gave off a luminous glow." --gloss "emitting light"'
  });

  await controller.callTool("shell_submit", {
    sessionId: started.sessionId,
    input: "/models"
  });

  await controller.callTool("shell_key", {
    sessionId: started.sessionId,
    key: "submit",
    waitForPrompt: true
  });

  const reviewOpened = await controller.callTool("shell_submit", {
    sessionId: started.sessionId,
    input: "/review"
  }) as {
    frame: {
      composer: {
        selectionPrompt: {
          promptText: string;
        } | null;
      };
      layout: {
        footer: {
          lines: string[];
        };
      };
    };
  };

  assert.equal(reviewOpened.frame.composer.selectionPrompt?.promptText, "Ready to peek?");
  assert.ok(
    reviewOpened.frame.layout.footer.lines.every(
      (line) => !/API key is missing|slipped|tripped/i.test(line)
    ),
    "expected the old /models error state to clear before the review flow begins"
  );

  await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  });
});

test("PawMemoShellMcpController exposes wait, resource list, and resource read helpers", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 72,
    rows: 20
  }) as {
    sessionId: string;
    snapshotId: string;
  };

  setTimeout(() => {
    void controller.callTool("shell_type", {
      sessionId: started.sessionId,
      text: "/he"
    });
  }, 10);

  const waited = await controller.callTool("shell_wait", {
    sessionId: started.sessionId,
    for: "snapshot-change",
    sinceSnapshotId: started.snapshotId,
    timeoutMs: 2_000
  }) as {
    snapshot: {
      frame: {
        composer: {
          buffer: string;
        };
      };
    };
  };

  assert.equal(waited.snapshot.frame.composer.buffer, "/he");

  const resources = controller.listResources();
  assert.ok(resources.some((resource) => resource.uri === "pawmemo://sessions"));
  assert.ok(
    resources.some(
      (resource) =>
        resource.uri === `pawmemo://sessions/${started.sessionId}/snapshots/latest/frame.txt`
    )
  );
  assert.ok(
    resources.some(
      (resource) =>
        resource.uri === `pawmemo://sessions/${started.sessionId}/snapshots/latest/frame.png`
    )
  );

  const sessionResource = controller.readResource(
    `pawmemo://sessions/${started.sessionId}`
  ) as {
    contents: Array<{
      text: string;
    }>;
  };
  assert.match(sessionResource.contents[0]?.text ?? "", /"snapshotCount":/);

  const frameResource = controller.readResource(
    `pawmemo://sessions/${started.sessionId}/snapshots/latest/frame.txt`
  ) as {
    contents: Array<{
      mimeType: string;
      text: string;
    }>;
  };
  assert.equal(frameResource.contents[0]?.mimeType, "text/plain");
  assert.match(frameResource.contents[0]?.text ?? "", /starting fresh/i);

  const imageResource = controller.readResource(
    `pawmemo://sessions/${started.sessionId}/snapshots/latest/frame.png`
  ) as {
    contents: Array<{
      mimeType: string;
      blob: string;
    }>;
  };
  assert.equal(imageResource.contents[0]?.mimeType, "image/png");
  assert.ok((imageResource.contents[0]?.blob ?? "").length > 0);

  const rendered = await controller.callTool("shell_render", {
    sessionId: started.sessionId
  }) as {
    content: Array<{
      type: string;
      mimeType?: string;
      data?: string;
    }>;
    structuredContent: {
      sessionId: string;
      snapshotId: string;
    };
  };
  assert.equal(rendered.structuredContent.sessionId, started.sessionId);
  assert.ok(rendered.structuredContent.snapshotId.length > 0);
  assert.ok(
    rendered.content.some(
      (entry) => entry.type === "image" && entry.mimeType === "image/png"
    )
  );

  await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  });
});

test("PawMemoShellMcpController retains only a bounded snapshot window per session", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 72,
    rows: 20
  }) as {
    sessionId: string;
    snapshotId: string;
  };

  for (let index = 0; index < 105; index += 1) {
    await controller.callTool("shell_type", {
      sessionId: started.sessionId,
      text: "x"
    });
  }

  const sessionResource = controller.readResource(
    `pawmemo://sessions/${started.sessionId}`
  ) as {
    contents: Array<{
      text: string;
    }>;
  };
  const payload = JSON.parse(sessionResource.contents[0]?.text ?? "{}") as {
    session: {
      snapshotCount: number;
      snapshotCapacity: number;
    };
    snapshots: Array<{
      snapshotId: string;
    }>;
  };

  assert.equal(payload.session.snapshotCount, 100);
  assert.equal(payload.session.snapshotCapacity, 100);
  assert.equal(payload.snapshots.length, 100);
  assert.ok(!payload.snapshots.some((snapshot) => snapshot.snapshotId === started.snapshotId));

  await assert.rejects(
    controller.callTool("shell_snapshot", {
      sessionId: started.sessionId,
      snapshotId: started.snapshotId
    }),
    /Unknown shell snapshot/
  );

  await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  });
});

test("PawMemoShellMcpController can stop a session while a selection prompt is active", async () => {
  const controller = new PawMemoShellMcpController({
    defaultDbPath: ":memory:"
  });

  const started = await controller.callTool("shell_start", {
    columns: 72,
    rows: 20
  }) as {
    sessionId: string;
  };

  const selection = await controller.callTool("shell_submit", {
    sessionId: started.sessionId,
    input: "/models"
  }) as {
    frame: {
      composer: {
        selectionPrompt: {
          promptText: string;
        } | null;
      };
    };
  };

  assert.equal(selection.frame.composer.selectionPrompt?.promptText, "Pick a provider");

  const stopped = await controller.callTool("shell_stop", {
    sessionId: started.sessionId
  }) as {
    stopped: boolean;
  };

  assert.equal(stopped.stopped, true);
});
