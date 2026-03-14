import fs from "node:fs";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";

import {
  PawMemoShellHarness,
  type ShellHarnessOptions,
  type ShellHarnessWaitCondition
} from "./shell-harness";
import { UsageError } from "../lib/errors";

type JsonRpcId = string | number | null;
const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
const DEFAULT_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
const MCP_SERVER_INFO = {
  name: "pawmemo-shell",
  title: "PawMemo Shell",
  version: "0.1.0"
} as const;
const SESSIONS_RESOURCE_URI = "pawmemo://sessions";

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

interface McpPromptArgumentDefinition {
  name: string;
  description?: string;
  required?: boolean;
}

interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgumentDefinition[];
}

interface McpPromptMessage {
  role: "user" | "assistant";
  content: {
    type: "text";
    text: string;
  };
}

interface McpServerOptions {
  defaultDbPath?: string;
}

interface McpCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface ToolCallOptions {
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  value: unknown,
  fieldName: string,
  required = true
): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (required) {
    throw new UsageError(`Missing ${fieldName}.`);
  }

  return undefined;
}

function readNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  throw new UsageError(`Missing ${fieldName}.`);
}

function readJsonRpcId(
  value: unknown,
  fieldName: string,
  required = true
): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }

  if (required) {
    throw new UsageError(`Missing ${fieldName}.`);
  }

  return undefined;
}

function readPromptArguments(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const args: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      args[key] = entry.trim();
    }
  }

  return args;
}

function formatToolResult(result: unknown) {
  if (
    isRecord(result) &&
    Array.isArray(result.content)
  ) {
    return {
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError === true
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: false,
    structuredContent: result
  };
}

function resolveProtocolVersion(params: unknown): string {
  if (!isRecord(params)) {
    return DEFAULT_MCP_PROTOCOL_VERSION;
  }

  const requested = readString(params.protocolVersion, "protocolVersion", false);
  return requested && MCP_PROTOCOL_VERSIONS.includes(requested as typeof MCP_PROTOCOL_VERSIONS[number])
    ? requested
    : DEFAULT_MCP_PROTOCOL_VERSION;
}

function parseUriPath(uri: string): string[] {
  const prefix = "pawmemo://";

  if (!uri.startsWith(prefix)) {
    throw new UsageError(`Unsupported resource URI: ${uri}`);
  }

  return uri
    .slice(prefix.length)
    .split("/")
    .filter((part) => part.length > 0);
}

function formatResourceContents(uri: string, mimeType: string, text: string) {
  return {
    contents: [
      {
        uri,
        mimeType,
        text
      }
    ]
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class PawMemoShellMcpController {
  private readonly sessions = new Map<string, PawMemoShellHarness>();

  constructor(private readonly options: McpServerOptions = {}) {}

  listTools(): McpToolDefinition[] {
    return [
      {
        name: "shell_start",
        description: "Start a headless PawMemo TUI shell session and return a semantic frame snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            dbPath: { type: "string" },
            packId: { type: "string" },
            columns: { type: "number" },
            rows: { type: "number" },
            debug: { type: "boolean" }
          }
        }
      },
      {
        name: "shell_submit",
        description: "Submit one full prompt line to an active PawMemo shell session and wait for the next prompt.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            input: { type: "string" },
            waitForPrompt: { type: "boolean" }
          },
          required: ["sessionId", "input"]
        }
      },
      {
        name: "shell_type",
        description: "Insert text into the active PawMemo shell composer without submitting it.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            text: { type: "string" },
            mode: { type: "string", enum: ["text", "paste"] }
          },
          required: ["sessionId", "text"]
        }
      },
      {
        name: "shell_key",
        description: "Send one external key event such as up, down, tab, left, right, submit, or backspace.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            key: {
              type: "string",
              enum: [
                "submit",
                "tab",
                "interrupt",
                "eof",
                "backspace",
                "escape",
                "delete",
                "left",
                "right",
                "home",
                "end",
                "up",
                "down",
                "page-up",
                "page-down",
                "shift-tab"
              ]
            },
            waitForPrompt: { type: "boolean" }
          },
          required: ["sessionId", "key"]
        }
      },
      {
        name: "shell_snapshot",
        description: "Read the current semantic frame snapshot for an active PawMemo shell session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            snapshotId: { type: "string" }
          },
          required: ["sessionId"]
        }
      },
      {
        name: "shell_resize",
        description: "Resize the PawMemo shell viewport and return the updated semantic frame snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            columns: { type: "number" },
            rows: { type: "number" }
          },
          required: ["sessionId", "columns", "rows"]
        }
      },
      {
        name: "shell_diff",
        description: "Diff two semantic PawMemo shell snapshots, defaulting to the latest two snapshots in the session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            fromSnapshotId: { type: "string" },
            toSnapshotId: { type: "string" }
          },
          required: ["sessionId"]
        }
      },
      {
        name: "shell_export",
        description: "Export the current or selected shell snapshot as txt, json, svg, or png.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            snapshotId: { type: "string" },
            format: { type: "string", enum: ["txt", "json", "svg", "png"] },
            outputPath: { type: "string" }
          },
          required: ["sessionId", "format"]
        }
      },
      {
        name: "shell_render",
        description: "Render the current or selected PawMemo shell snapshot as a PNG image for visual layout inspection.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            snapshotId: { type: "string" }
          },
          required: ["sessionId"]
        }
      },
      {
        name: "shell_wait",
        description: "Wait for a prompt, the next prompt cycle, or a snapshot change, then return the resulting snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            for: {
              type: "string",
              enum: ["prompt", "next-prompt", "snapshot-change"]
            },
            sinceSnapshotId: { type: "string" },
            timeoutMs: { type: "number" }
          },
          required: ["sessionId", "for"]
        }
      },
      {
        name: "shell_stop",
        description: "Stop an active PawMemo shell session.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" }
          },
          required: ["sessionId"]
        }
      }
    ];
  }

  async callTool(
    name: string,
    args: unknown,
    options: ToolCallOptions = {}
  ): Promise<unknown> {
    const params = isRecord(args) ? args : {};

    switch (name) {
      case "shell_start":
        return await this.startSession(params, options.signal);
      case "shell_submit":
        return await this.submitToSession(params, options.signal);
      case "shell_snapshot":
        return this.getSessionSnapshot(params);
      case "shell_resize":
        return this.resizeSession(params);
      case "shell_type":
        return this.typeInSession(params);
      case "shell_key":
        return await this.sendKeyToSession(params, options.signal);
      case "shell_diff":
        return this.diffSessionSnapshots(params);
      case "shell_export":
        return this.exportSessionSnapshot(params);
      case "shell_render":
        return this.renderSessionSnapshot(params);
      case "shell_wait":
        return await this.waitForSession(params, options.signal);
      case "shell_stop":
        return await this.stopSession(params);
      default:
        throw new UsageError(`Unknown MCP tool: ${name}`);
    }
  }

  listResources(): McpResourceDefinition[] {
    const resources: McpResourceDefinition[] = [
      {
        uri: SESSIONS_RESOURCE_URI,
        name: "sessions",
        title: "PawMemo Shell Sessions",
        description: "Active PawMemo shell debug sessions and their latest snapshot metadata.",
        mimeType: "application/json"
      }
    ];

    for (const session of this.sessions.values()) {
      const summary = session.getSessionSummary();
      resources.push({
        uri: `pawmemo://sessions/${summary.sessionId}`,
        name: `session-${summary.sessionId}`,
        title: `Session ${summary.sessionId}`,
        description: "Session summary with the latest snapshot id and viewport state.",
        mimeType: "application/json"
      });
      resources.push({
        uri: `pawmemo://sessions/${summary.sessionId}/snapshots/latest`,
        name: `session-${summary.sessionId}-snapshot-latest`,
        title: `Latest Snapshot ${summary.sessionId}`,
        description: "Latest semantic shell frame snapshot for this session.",
        mimeType: "application/json"
      });
      resources.push({
        uri: `pawmemo://sessions/${summary.sessionId}/snapshots/latest/frame.txt`,
        name: `session-${summary.sessionId}-frame-latest`,
        title: `Latest Frame Text ${summary.sessionId}`,
        description: "Rendered plain-text frame for the latest snapshot.",
        mimeType: "text/plain"
      });
      resources.push({
        uri: `pawmemo://sessions/${summary.sessionId}/snapshots/latest/frame.png`,
        name: `session-${summary.sessionId}-frame-image-latest`,
        title: `Latest Frame Image ${summary.sessionId}`,
        description: "Rendered PNG image for the latest snapshot.",
        mimeType: "image/png"
      });
    }

    return resources;
  }

  listResourceTemplates(): McpResourceTemplateDefinition[] {
    return [
      {
        uriTemplate: "pawmemo://sessions/{sessionId}/snapshots/{snapshotId}",
        name: "session-snapshot",
        title: "Session Snapshot",
        description: "Read one semantic shell frame snapshot by session id and snapshot id.",
        mimeType: "application/json"
      },
      {
        uriTemplate: "pawmemo://sessions/{sessionId}/snapshots/{snapshotId}/frame.txt",
        name: "session-snapshot-frame-text",
        title: "Session Snapshot Frame Text",
        description: "Read one rendered plain-text shell frame by session id and snapshot id.",
        mimeType: "text/plain"
      },
      {
        uriTemplate: "pawmemo://sessions/{sessionId}/snapshots/{snapshotId}/frame.png",
        name: "session-snapshot-frame-image",
        title: "Session Snapshot Frame Image",
        description: "Read one rendered PNG shell frame by session id and snapshot id.",
        mimeType: "image/png"
      }
    ];
  }

  listPrompts(): McpPromptDefinition[] {
    return [
      {
        name: "start_learning_session",
        title: "Start Learning Session",
        description:
          "Guide Codex through starting or resuming a small PawMemo shell study session.",
        arguments: [
          {
            name: "goal",
            description:
              "Optional study goal such as capture a word, teach a word, review, or rescue."
          },
          {
            name: "sessionId",
            description:
              "Optional existing shell session id to continue instead of starting a new one."
          }
        ]
      },
      {
        name: "inspect_shell_session",
        title: "Inspect Shell Session",
        description:
          "Guide Codex through inspecting a live PawMemo shell session with semantic snapshots.",
        arguments: [
          {
            name: "sessionId",
            description: "Active PawMemo shell session id to inspect.",
            required: true
          },
          {
            name: "focus",
            description:
              "Optional inspection focus such as layout, waiting state, review flow, or model picker."
          }
        ]
      }
    ];
  }

  getPrompt(name: string, args: Record<string, string> = {}): {
    description?: string;
    messages: McpPromptMessage[];
  } {
    switch (name) {
      case "start_learning_session": {
        const goal = args.goal ?? "start a gentle study turn";
        const sessionId = args.sessionId;
        const opener = sessionId
          ? `Continue PawMemo shell session ${sessionId}. Start by reading pawmemo://sessions/${sessionId} and the latest snapshot resources before acting.`
          : "Start a fresh PawMemo shell session with `shell_start`, then inspect the returned semantic snapshot before taking any action.";

        return {
          description:
            "Use PawMemo's MCP shell surface to begin or resume a compact study interaction.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  `${opener} Help the learner ${goal}. Prefer one small step such as capture, teach, review, or rescue. Keep the interaction warm, cute, and emotionally safe. Use shell tools and semantic snapshots as the source of truth, and do not invent saved memories or scheduling state.`
              }
            }
          ]
        };
      }
      case "inspect_shell_session": {
        const sessionId = readString(args.sessionId, "sessionId") ?? "";
        const focus = args.focus ?? "the current shell state";

        return {
          description:
            "Inspect a live PawMemo shell session through MCP resources and shell tools.",
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text:
                  `Inspect PawMemo shell session ${sessionId} with a focus on ${focus}. Start from pawmemo://sessions/${sessionId}, then compare the latest semantic snapshot and frame resources before making changes. Prefer semantic snapshots over guessed terminal behavior, and describe any before/after shell delta using the observed frame state.`
              }
            }
          ]
        };
      }
      default:
        throw new UsageError(`Unknown MCP prompt: ${name}`);
    }
  }

  readResource(uri: string): unknown {
    if (uri === SESSIONS_RESOURCE_URI) {
      return formatResourceContents(
        uri,
        "application/json",
        `${JSON.stringify(
          {
            sessions: [...this.sessions.values()].map((session) =>
              session.getSessionSummary()
            )
          },
          null,
          2
        )}\n`
      );
    }

    const pathParts = parseUriPath(uri);
    if (pathParts[0] !== "sessions") {
      throw new UsageError(`Unknown resource URI: ${uri}`);
    }

    const sessionId = pathParts[1];
    if (!sessionId) {
      throw new UsageError(`Unknown resource URI: ${uri}`);
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new UsageError(`Unknown shell session: ${sessionId}`);
    }

    if (pathParts.length === 2) {
      return formatResourceContents(
        uri,
        "application/json",
        `${JSON.stringify(
          {
            session: session.getSessionSummary(),
            snapshots: session.listSnapshotSummaries()
          },
          null,
          2
        )}\n`
      );
    }

    if (pathParts[2] !== "snapshots") {
      throw new UsageError(`Unknown resource URI: ${uri}`);
    }

    const snapshotToken = pathParts[3];
    if (!snapshotToken) {
      throw new UsageError(`Unknown resource URI: ${uri}`);
    }

    const snapshot =
      snapshotToken === "latest"
        ? session.getLatestSnapshot()
        : session.getSnapshotById(snapshotToken);

    if (pathParts.length === 4) {
      return formatResourceContents(
        uri,
        "application/json",
        `${JSON.stringify(snapshot, null, 2)}\n`
      );
    }

    if (pathParts.length === 5 && pathParts[4] === "frame.txt") {
      return formatResourceContents(
        uri,
        "text/plain",
        `${snapshot.frame.rendered.frameText}\n`
      );
    }

    if (pathParts.length === 5 && pathParts[4] === "frame.png") {
      const exported = session.exportSnapshot("png", snapshot.snapshotId);
      const blob = fs.readFileSync(exported.path).toString("base64");

      return {
        contents: [
          {
            uri,
            mimeType: "image/png",
            blob
          }
        ]
      };
    }

    throw new UsageError(`Unknown resource URI: ${uri}`);
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();

    await Promise.all(
      sessions.map(async (session) => {
        await session.stop();
      })
    );
  }

  private async startSession(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const harnessOptions: ShellHarnessOptions = {
      dbPath:
        readString(params.dbPath, "dbPath", false) ?? this.options.defaultDbPath,
      packId: readString(params.packId, "packId", false),
      columns:
        typeof params.columns === "number" ? Math.trunc(params.columns) : undefined,
      rows: typeof params.rows === "number" ? Math.trunc(params.rows) : undefined,
      debug: params.debug === true
    };
    const session = new PawMemoShellHarness(harnessOptions);

    let snapshot: Awaited<ReturnType<typeof session.start>>;
    try {
      snapshot = await session.start(signal);
    } catch (error) {
      await session.stop().catch(() => {});
      throw error;
    }

    this.sessions.set(session.sessionId, session);
    return snapshot;
  }

  private async submitToSession(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const session = this.requireSession(params);
    const input = readString(params.input, "input") ?? "";

    return await session.submit(input, params.waitForPrompt !== false, signal);
  }

  private getSessionSnapshot(params: Record<string, unknown>): unknown {
    const session = this.requireSession(params);
    const snapshotId = readString(params.snapshotId, "snapshotId", false);
    return snapshotId ? session.getSnapshotById(snapshotId) : session.snapshot();
  }

  private resizeSession(params: Record<string, unknown>): unknown {
    const session = this.requireSession(params);
    const columns = Math.trunc(readNumber(params.columns, "columns"));
    const rows = Math.trunc(readNumber(params.rows, "rows"));

    return session.resize(columns, rows);
  }

  private typeInSession(params: Record<string, unknown>): unknown {
    const session = this.requireSession(params);
    const text = readString(params.text, "text") ?? "";
    const mode = readString(params.mode, "mode", false) ?? "text";

    if (mode === "paste") {
      return session.pasteText(text);
    }

    return session.typeText(text);
  }

  private async sendKeyToSession(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const session = this.requireSession(params);
    const key = readString(params.key, "key") as Parameters<typeof session.pressKey>[0];

    return await session.pressKey(key, params.waitForPrompt === true, signal);
  }

  private diffSessionSnapshots(params: Record<string, unknown>): unknown {
    const session = this.requireSession(params);
    return session.diffSnapshots(
      readString(params.fromSnapshotId, "fromSnapshotId", false),
      readString(params.toSnapshotId, "toSnapshotId", false)
    );
  }

  private exportSessionSnapshot(params: Record<string, unknown>): unknown {
    const session = this.requireSession(params);
    const format = readString(params.format, "format") as "txt" | "json" | "svg" | "png";

    if (format !== "txt" && format !== "json" && format !== "svg" && format !== "png") {
      throw new UsageError("`format` must be txt, json, svg, or png.");
    }

    return session.exportSnapshot(
      format,
      readString(params.snapshotId, "snapshotId", false),
      readString(params.outputPath, "outputPath", false)
    );
  }

  private renderSessionSnapshot(params: Record<string, unknown>): McpCallToolResult {
    const session = this.requireSession(params);
    const snapshotId = readString(params.snapshotId, "snapshotId", false);
    const exported = session.exportSnapshot("png", snapshotId);
    const imageBase64 = fs.readFileSync(exported.path).toString("base64");
    const snapshot = snapshotId
      ? session.getSnapshotById(snapshotId)
      : session.getLatestSnapshot();

    return {
      content: [
        {
          type: "text",
          text: `Rendered PawMemo shell snapshot ${snapshot.snapshotId} as image/png.`
        },
        {
          type: "image",
          data: imageBase64,
          mimeType: "image/png"
        }
      ],
      structuredContent: {
        sessionId: session.sessionId,
        snapshotId: snapshot.snapshotId,
        viewport: snapshot.frame.viewport,
        path: exported.path
      },
      isError: false
    };
  }

  private async waitForSession(
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const session = this.requireSession(params);
    const condition = readString(params.for, "for") as ShellHarnessWaitCondition;
    const timeoutMs =
      typeof params.timeoutMs === "number" ? Math.trunc(params.timeoutMs) : undefined;

    if (
      condition !== "prompt" &&
      condition !== "next-prompt" &&
      condition !== "snapshot-change"
    ) {
      throw new UsageError("`for` must be prompt, next-prompt, or snapshot-change.");
    }

    return await session.waitFor(condition, {
      sinceSnapshotId: readString(params.sinceSnapshotId, "sinceSnapshotId", false),
      timeoutMs,
      signal
    });
  }

  private async stopSession(params: Record<string, unknown>): Promise<unknown> {
    const session = this.requireSession(params);
    this.sessions.delete(session.sessionId);
    await session.stop();

    return {
      sessionId: session.sessionId,
      stopped: true
    };
  }

  private requireSession(params: Record<string, unknown>): PawMemoShellHarness {
    const sessionId = readString(params.sessionId, "sessionId") ?? "";
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new UsageError(`Unknown shell session: ${sessionId}`);
    }

    return session;
  }
}

function writeJson(message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function writeError(id: JsonRpcId, code: number, message: string): void {
  writeJson({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  });
}

function writeResult(id: JsonRpcId, result: unknown): void {
  writeJson({
    jsonrpc: "2.0",
    id,
    result
  });
}

export async function runShellMcpServer(
  options: McpServerOptions = {}
): Promise<void> {
  const controller = new PawMemoShellMcpController(options);
  const lines = createInterface({
    input,
    crlfDelay: Infinity
  });
  let initialized = false;
  const inFlightRequests = new Map<
    string | number,
    {
      controller: AbortController;
      cancelled: boolean;
    }
  >();
  const activeTasks = new Set<Promise<void>>();

  const trackTask = (task: Promise<void>): void => {
    activeTasks.add(task);
    void task.finally(() => {
      activeTasks.delete(task);
    });
  };

  const cancelRequest = (requestId: JsonRpcId | undefined): void => {
    if (
      requestId === undefined ||
      requestId === null
    ) {
      return;
    }

    const entry = inFlightRequests.get(requestId);
    if (!entry || entry.cancelled) {
      return;
    }

    entry.cancelled = true;
    entry.controller.abort(new DOMException("Request cancelled.", "AbortError"));
  };

  const handleRequest = async (request: JsonRpcRequest): Promise<void> => {
    const requestId = request.id ?? null;

    try {
      switch (request.method) {
        case "initialize":
          initialized = true;
          writeResult(requestId, {
            protocolVersion: resolveProtocolVersion(request.params),
            serverInfo: MCP_SERVER_INFO,
            capabilities: {
              tools: {
                listChanged: false
              },
              resources: {
                listChanged: false,
                subscribe: false
              },
              prompts: {
                listChanged: false
              }
            }
          });
          return;
        case "notifications/initialized":
          return;
        case "notifications/cancelled":
          cancelRequest(
            readJsonRpcId(
              isRecord(request.params) ? request.params.requestId : undefined,
              "requestId",
              false
            )
          );
          return;
        case "ping":
          writeResult(requestId, {});
          return;
        case "tools/list":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(requestId, {
            tools: controller.listTools()
          });
          return;
        case "resources/list":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(requestId, {
            resources: controller.listResources(),
            nextCursor: null
          });
          return;
        case "resources/templates/list":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(requestId, {
            resourceTemplates: controller.listResourceTemplates(),
            nextCursor: null
          });
          return;
        case "resources/read":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(
            requestId,
            controller.readResource(
              readString(
                isRecord(request.params) ? request.params.uri : undefined,
                "uri"
              ) ?? ""
            )
          );
          return;
        case "prompts/list":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(requestId, {
            prompts: controller.listPrompts(),
            nextCursor: null
          });
          return;
        case "prompts/get":
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }
          writeResult(
            requestId,
            controller.getPrompt(
              readString(
                isRecord(request.params) ? request.params.name : undefined,
                "name"
              ) ?? "",
              readPromptArguments(
                isRecord(request.params) ? request.params.arguments : undefined
              )
            )
          );
          return;
        case "tools/call": {
          if (!initialized) {
            throw new UsageError("Server not initialized.");
          }

          const params = isRecord(request.params) ? request.params : {};
          const name = readString(params.name, "name") ?? "";
          const args = params.arguments;
          const requestKey =
            requestId === null ? undefined : requestId;
          const abortController = new AbortController();

          if (requestKey !== undefined) {
            inFlightRequests.set(requestKey, {
              controller: abortController,
              cancelled: false
            });
          }

          try {
            const result = await controller.callTool(name, args, {
              signal: abortController.signal
            });
            const requestState =
              requestKey !== undefined ? inFlightRequests.get(requestKey) : undefined;

            if (requestState?.cancelled) {
              return;
            }

            writeResult(requestId, formatToolResult(result));
            return;
          } catch (error) {
            const requestState =
              requestKey !== undefined ? inFlightRequests.get(requestKey) : undefined;

            if (requestState?.cancelled && isAbortError(error)) {
              return;
            }

            throw error;
          } finally {
            if (requestKey !== undefined) {
              inFlightRequests.delete(requestKey);
            }
          }
        }
        default:
          writeError(requestId, -32601, `Method not found: ${request.method}`);
          return;
      }
    } catch (error) {
      const requestKey = request.id ?? null;

      if (
        requestKey !== null &&
        inFlightRequests.get(requestKey)?.cancelled &&
        isAbortError(error)
      ) {
        return;
      }

      const message =
        error instanceof Error ? error.message : "Internal error";
      writeError(requestId, -32000, message);
    }
  };

  try {
    for await (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }

      let request: JsonRpcRequest;

      try {
        request = JSON.parse(line) as JsonRpcRequest;
      } catch {
        writeError(null, -32700, "Parse error");
        continue;
      }

      if (request.method === "tools/call") {
        trackTask(handleRequest(request));
        continue;
      }

      await handleRequest(request);
    }
  } finally {
    lines.close();

    for (const [requestId] of inFlightRequests) {
      cancelRequest(requestId);
    }

    if (activeTasks.size > 0) {
      await Promise.allSettled([...activeTasks]);
    }

    await controller.shutdown().catch((error: unknown) => {
      if (error instanceof Error) {
        stderr.write(`${error.message}\n`);
      }
    });
  }
}
