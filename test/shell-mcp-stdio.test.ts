import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
  };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

class JsonRpcClientHarness {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  readonly orphanedResponses: JsonRpcResponse[] = [];
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor() {
    const cliPath = path.resolve(process.cwd(), "dist", "src", "cli", "index.js");
    this.child = spawn(process.execPath, [cliPath, "mcp", "--db", ":memory:"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.onStdout(chunk.toString("utf8"));
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  request(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    return this.requestWithId(method, params, timeoutMs).promise;
  }

  requestWithId(
    method: string,
    params?: unknown,
    timeoutMs = 10_000
  ): { id: number; promise: Promise<unknown> } {
    const id = this.nextId++;
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
    );

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer
      });
    });

    return {
      id,
      promise
    };
  }

  cancel(id: number, reason = "Request cancelled by client."): void {
    const pending = this.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }

    this.notify("notifications/cancelled", {
      requestId: id,
      reason
    });
  }

  async close(): Promise<void> {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP test harness closed before the response arrived."));
    }
    this.pending.clear();

    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }

    await new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id === undefined) {
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        this.orphanedResponses.push(message);
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(message.id);

      if ("error" in message) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}

test("PawMemo MCP stdio server exposes modern handshake and readable resources", async () => {
  const client = new JsonRpcClientHarness();

  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "pawmemo-test",
        version: "1.0.0"
      }
    }) as {
      protocolVersion: string;
      serverInfo: {
        name: string;
        title: string;
      };
      capabilities: {
        tools: Record<string, unknown>;
        resources: Record<string, unknown>;
        prompts: Record<string, unknown>;
      };
    };

    assert.equal(initialized.protocolVersion, "2025-03-26");
    assert.equal(initialized.serverInfo.name, "pawmemo-shell");
    assert.equal(initialized.serverInfo.title, "PawMemo Shell");
    assert.ok("tools" in initialized.capabilities);
    assert.ok("resources" in initialized.capabilities);
    assert.ok("prompts" in initialized.capabilities);

    client.notify("notifications/initialized");

    const resourcesBefore = await client.request("resources/list", {}) as {
      resources: Array<{
        uri: string;
      }>;
    };
    assert.ok(
      resourcesBefore.resources.some((resource) => resource.uri === "pawmemo://server")
    );
    assert.ok(
      resourcesBefore.resources.some((resource) => resource.uri === "pawmemo://sessions")
    );

    const serverStatus = await client.request("tools/call", {
      name: "server_status",
      arguments: {}
    }) as {
      structuredContent: {
        processId: number;
        freshness: {
          isStale: boolean;
          hint: string;
        };
      };
    };
    assert.equal(typeof serverStatus.structuredContent.processId, "number");
    assert.equal(typeof serverStatus.structuredContent.freshness.isStale, "boolean");
    assert.match(serverStatus.structuredContent.freshness.hint, /MCP process/i);

    const serverResource = await client.request("resources/read", {
      uri: "pawmemo://server"
    }) as {
      contents: Array<{
        mimeType: string;
        text: string;
      }>;
    };
    assert.equal(serverResource.contents[0]?.mimeType, "application/json");
    assert.match(serverResource.contents[0]?.text ?? "", /"processId":/);
    assert.match(serverResource.contents[0]?.text ?? "", /"freshness":/);

    const templates = await client.request("resources/templates/list", {}) as {
      resourceTemplates: Array<{
        uriTemplate: string;
      }>;
    };
    assert.ok(
      templates.resourceTemplates.some(
        (template) =>
          template.uriTemplate === "pawmemo://sessions/{sessionId}/snapshots/{snapshotId}"
      )
    );

    const prompts = await client.request("prompts/list", {}) as {
      prompts: Array<{
        name: string;
      }>;
    };
    assert.ok(
      prompts.prompts.some((prompt) => prompt.name === "start_learning_session")
    );
    assert.ok(
      prompts.prompts.some((prompt) => prompt.name === "inspect_shell_session")
    );

    const tools = await client.request("tools/list", {}) as {
      tools: Array<{
        name: string;
      }>;
    };
    assert.ok(
      tools.tools.some((tool) => tool.name === "server_reload")
    );

    const started = await client.request("tools/call", {
      name: "shell_start",
      arguments: {
        dbPath: ":memory:",
        columns: 72,
        rows: 20
      }
    }) as {
      structuredContent: {
        sessionId: string;
      };
    };

    const sessionId = started.structuredContent.sessionId;
    assert.match(sessionId, /-/);

    const inspectPrompt = await client.request("prompts/get", {
      name: "inspect_shell_session",
      arguments: {
        sessionId,
        focus: "layout"
      }
    }) as {
      messages: Array<{
        content: {
          text: string;
        };
      }>;
    };

    assert.match(
      inspectPrompt.messages[0]?.content.text ?? "",
      new RegExp(`pawmemo://sessions/${sessionId}`)
    );

    const latestFrame = await client.request("resources/read", {
      uri: `pawmemo://sessions/${sessionId}/snapshots/latest/frame.txt`
    }) as {
      contents: Array<{
        mimeType: string;
        text: string;
      }>;
    };

    assert.equal(latestFrame.contents[0]?.mimeType, "text/plain");
    assert.match(latestFrame.contents[0]?.text ?? "", /starting fresh/i);

    const latestFrameImage = await client.request("resources/read", {
      uri: `pawmemo://sessions/${sessionId}/snapshots/latest/frame.png`
    }) as {
      contents: Array<{
        mimeType: string;
        blob: string;
      }>;
    };

    assert.equal(latestFrameImage.contents[0]?.mimeType, "image/png");
    assert.ok((latestFrameImage.contents[0]?.blob ?? "").length > 0);

    const rendered = await client.request("tools/call", {
      name: "shell_render",
      arguments: {
        sessionId
      }
    }) as {
      content: Array<{
        type: string;
        mimeType?: string;
      }>;
      structuredContent: {
        sessionId: string;
      };
    };

    assert.equal(rendered.structuredContent.sessionId, sessionId);
    assert.ok(
      rendered.content.some(
        (entry) => entry.type === "image" && entry.mimeType === "image/png"
      )
    );

    await client.request("tools/call", {
      name: "shell_stop",
      arguments: {
        sessionId
      }
    });
  } finally {
    await client.close();
  }
});

test("PawMemo MCP stdio supervisor can reload the worker without a client reconnect", async () => {
  const client = new JsonRpcClientHarness();

  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "pawmemo-test",
        version: "1.0.0"
      }
    });
    client.notify("notifications/initialized");

    const beforeStatus = await client.request("tools/call", {
      name: "server_status",
      arguments: {}
    }) as {
      structuredContent: {
        processId: number;
      };
    };

    const reload = await client.request("tools/call", {
      name: "server_reload",
      arguments: {}
    }) as {
      structuredContent: {
        reloaded: boolean;
        oldWorkerProcessId: number | null;
        newWorkerProcessId: number | null;
      };
    };

    assert.equal(reload.structuredContent.reloaded, true);
    assert.equal(
      reload.structuredContent.oldWorkerProcessId,
      beforeStatus.structuredContent.processId
    );
    assert.notEqual(
      reload.structuredContent.newWorkerProcessId,
      beforeStatus.structuredContent.processId
    );

    const afterStatus = await client.request("tools/call", {
      name: "server_status",
      arguments: {}
    }) as {
      structuredContent: {
        processId: number;
      };
    };

    assert.equal(
      afterStatus.structuredContent.processId,
      reload.structuredContent.newWorkerProcessId
    );

    const started = await client.request("tools/call", {
      name: "shell_start",
      arguments: {
        dbPath: ":memory:",
        columns: 72,
        rows: 20
      }
    }) as {
      structuredContent: {
        sessionId: string;
      };
    };

    assert.match(started.structuredContent.sessionId, /-/);
  } finally {
    await client.close();
  }
});

test("PawMemo MCP stdio server cancels blocked tool calls without leaking later responses", async () => {
  const client = new JsonRpcClientHarness();

  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "pawmemo-test",
        version: "1.0.0"
      }
    });
    client.notify("notifications/initialized");

    const started = await client.request("tools/call", {
      name: "shell_start",
      arguments: {
        dbPath: ":memory:",
        columns: 72,
        rows: 20
      }
    }) as {
      structuredContent: {
        sessionId: string;
        snapshotId: string;
      };
    };

    const sessionId = started.structuredContent.sessionId;
    const baselineSnapshotId = started.structuredContent.snapshotId;
    const pendingWait = client.requestWithId("tools/call", {
      name: "shell_wait",
      arguments: {
        sessionId,
        for: "snapshot-change",
        sinceSnapshotId: baselineSnapshotId,
        timeoutMs: 300
      }
    });

    client.cancel(pendingWait.id);
    await assert.rejects(pendingWait.promise, /Request cancelled by client/);

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(
      !client.orphanedResponses.some((message) => message.id === pendingWait.id)
    );

    const pong = await client.request("ping", {});
    assert.deepEqual(pong, {});

    await client.request("tools/call", {
      name: "shell_stop",
      arguments: {
        sessionId
      }
    });
  } finally {
    await client.close();
  }
});
