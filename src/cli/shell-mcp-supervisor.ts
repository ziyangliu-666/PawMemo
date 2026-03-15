import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output, stderr } from "node:process";

import { UsageError } from "../lib/errors";

const WORKER_ENV_FLAG = "PAWMEMO_MCP_WORKER";
const DEFAULT_MCP_PROTOCOL_VERSION = "2025-03-26";
const SERVER_RELOAD_TOOL_NAME = "server_reload";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface McpServerOptions {
  defaultDbPath?: string;
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpCallToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface LatestFileSnapshot {
  rootPath: string;
  latestPath: string | null;
  latestModifiedAt: string | null;
  latestModifiedMs: number | null;
}

interface WorkerServerStatus {
  processId: number;
  activeSessionCount: number;
  activeSessionIds: string[];
  dist: {
    rootPath: string;
    latestPath: string | null;
    latestModifiedAt: string | null;
    changedSinceLaunch: boolean;
  };
  freshness: {
    serverStartedAt: string;
    latestBuildAt: string | null;
    isStale: boolean;
    hint: string;
  };
}

interface ServerReloadResult {
  reloaded: boolean;
  reason: string;
  wasStale: boolean;
  droppedSessionCount: number;
  oldWorkerProcessId: number | null;
  newWorkerProcessId: number | null;
  freshness: WorkerServerStatus["freshness"] | null;
}

interface PendingWorkerRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
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

function readBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function toIsoTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function scanLatestModifiedFile(rootPath: string): LatestFileSnapshot {
  const latest = {
    path: null as string | null,
    modifiedMs: null as number | null
  };

  const visit = (currentPath: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = fs.statSync(entryPath);
      } catch {
        continue;
      }

      if (latest.modifiedMs === null || stats.mtimeMs > latest.modifiedMs) {
        latest.modifiedMs = stats.mtimeMs;
        latest.path = entryPath;
      }
    }
  };

  visit(rootPath);

  return {
    rootPath,
    latestPath: latest.path,
    latestModifiedAt:
      latest.modifiedMs === null ? null : toIsoTimestamp(latest.modifiedMs),
    latestModifiedMs: latest.modifiedMs
  };
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

function formatToolResult(result: unknown): McpCallToolResult {
  if (isRecord(result) && Array.isArray(result.content)) {
    const content = result.content.filter((entry): entry is Record<string, unknown> =>
      isRecord(entry)
    );

    return {
      content,
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createServerReloadTool(): McpToolDefinition {
  return {
    name: SERVER_RELOAD_TOOL_NAME,
    description:
      "Reload the supervised PawMemo MCP worker without reconnecting the client. Drops active shell sessions only when force=true.",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean" },
        ifStale: { type: "boolean" }
      }
    }
  };
}

function extractWorkerStatus(result: unknown): WorkerServerStatus {
  const structuredContent =
    isRecord(result) && "structuredContent" in result
      ? result.structuredContent
      : result;

  if (!isRecord(structuredContent)) {
    throw new Error("Worker did not return a structured server status.");
  }

  return structuredContent as unknown as WorkerServerStatus;
}

class PawMemoShellMcpSupervisor {
  private worker: ChildProcessWithoutNullStreams | null = null;
  private workerStdoutBuffer = "";
  private readonly pendingWorkerRequests = new Map<string, PendingWorkerRequest>();
  private readonly workerRequestByClientId = new Map<string | number, string>();
  private readonly cancelledClientRequests = new Set<string | number>();
  private nextWorkerRequestId = 1;
  private initializeParams: unknown = undefined;
  private initialized = false;
  private initializedNotificationSeen = false;
  private workerStartedAtMs: number | null = null;
  private reloadTask: Promise<ServerReloadResult> | null = null;

  constructor(private readonly options: McpServerOptions = {}) {}

  async handleRequest(request: JsonRpcRequest): Promise<void> {
    const requestId = request.id ?? null;

    try {
      switch (request.method) {
        case "initialize": {
          this.initializeParams = request.params;
          const result = await this.requestWorker("initialize", request.params);
          this.initialized = true;
          writeResult(requestId, result);
          return;
        }
        case "notifications/initialized":
          this.initializedNotificationSeen = true;
          this.notifyWorker("notifications/initialized");
          return;
        case "notifications/cancelled": {
          const requestIdToCancel = isRecord(request.params)
            ? request.params.requestId
            : undefined;
          this.cancelClientRequest(requestIdToCancel);
          return;
        }
        case "ping":
          await this.ensureWorkerReady();
          writeResult(requestId, {});
          return;
        case "tools/list": {
          if (!this.initialized) {
            throw new UsageError("Server not initialized.");
          }

          await this.ensureFreshWorkerIfSafe();
          const result = await this.requestWorker("tools/list", request.params);
          writeResult(requestId, this.withSupervisorTools(result));
          return;
        }
        case "tools/call": {
          if (!this.initialized) {
            throw new UsageError("Server not initialized.");
          }

          const params = isRecord(request.params) ? request.params : {};
          const toolName = readString(params.name, "name") ?? "";

          if (toolName === SERVER_RELOAD_TOOL_NAME) {
            const handled = await this.handleServerReloadTool(params.arguments);
            writeResult(requestId, formatToolResult(handled));
            return;
          }

          await this.ensureFreshWorkerIfSafe();
          const result = await this.requestWorker("tools/call", request.params, {
            clientRequestId: requestId
          });
          writeResult(requestId, result);
          return;
        }
        default:
          if (!this.initialized) {
            throw new UsageError("Server not initialized.");
          }

          await this.ensureFreshWorkerIfSafe();
          writeResult(
            requestId,
            await this.requestWorker(request.method, request.params, {
              clientRequestId: requestId
            })
          );
          return;
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      const message = error instanceof Error ? error.message : "Internal error";
      writeError(requestId, -32000, message);
    }
  }

  async shutdown(): Promise<void> {
    this.pendingWorkerRequests.forEach((entry) => {
      entry.reject(new Error("Supervisor shut down before the worker responded."));
    });
    this.pendingWorkerRequests.clear();
    this.workerRequestByClientId.clear();
    this.cancelledClientRequests.clear();
    await this.stopWorker();
  }

  private async ensureWorkerReady(): Promise<void> {
    if (this.worker && this.worker.exitCode === null && this.worker.killed === false) {
      return;
    }

    this.startWorker();

    if (this.initialized) {
      await this.bootstrapWorkerAfterSpawn();
    }
  }

  private async ensureFreshWorkerIfSafe(): Promise<void> {
    await this.ensureWorkerReady();

    if (!this.initialized || !this.isWorkerStale()) {
      return;
    }

    const status = await this.getWorkerStatus().catch(() => null);
    if (!status || status.activeSessionCount > 0) {
      return;
    }

    await this.reloadWorker({
      reason: "auto-refresh-idle-stale-worker",
      ifStale: true,
      force: false
    });
  }

  private isWorkerStale(): boolean {
    if (this.workerStartedAtMs === null) {
      return false;
    }

    const latestDist = scanLatestModifiedFile(this.getDistRootPath());
    return (
      latestDist.latestModifiedMs !== null &&
      latestDist.latestModifiedMs > this.workerStartedAtMs
    );
  }

  private getDistRootPath(): string {
    return path.resolve(__dirname, "..", "..");
  }

  private withSupervisorTools(result: unknown): unknown {
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      return result;
    }

    const tools: Array<Record<string, unknown> | McpToolDefinition> = result.tools.filter(
      (tool): tool is Record<string, unknown> => isRecord(tool)
    );
    if (
      !tools.some(
        (tool) => isRecord(tool) && tool.name === SERVER_RELOAD_TOOL_NAME
      )
    ) {
      tools.push(createServerReloadTool());
    }

    return {
      ...result,
      tools
    };
  }

  private async handleServerReloadTool(args: unknown): Promise<ServerReloadResult> {
    const params = isRecord(args) ? args : {};
    return await this.reloadWorker({
      reason: "manual-server-reload",
      force: readBoolean(params.force, false),
      ifStale: readBoolean(params.ifStale, false)
    });
  }

  private async reloadWorker(input: {
    reason: string;
    force: boolean;
    ifStale: boolean;
  }): Promise<ServerReloadResult> {
    if (this.reloadTask) {
      return await this.reloadTask;
    }

    this.reloadTask = (async () => {
      await this.ensureWorkerReady();

      const wasStale = this.isWorkerStale();
      const before = await this.getWorkerStatus().catch(() => null);

      if (input.ifStale && !wasStale) {
        return {
          reloaded: false,
          reason: "worker already matches the latest dist build",
          wasStale,
          droppedSessionCount: 0,
          oldWorkerProcessId: before?.processId ?? this.worker?.pid ?? null,
          newWorkerProcessId: before?.processId ?? this.worker?.pid ?? null,
          freshness: before?.freshness ?? null
        };
      }

      const activeSessionCount = before?.activeSessionCount ?? 0;
      if (activeSessionCount > 0 && !input.force) {
        throw new UsageError(
          `Cannot reload the MCP worker while ${activeSessionCount} shell session(s) are active. Stop them first or pass force=true.`
        );
      }

      const oldWorkerProcessId = before?.processId ?? this.worker?.pid ?? null;
      await this.stopWorker();
      this.startWorker();

      if (this.initialized) {
        await this.bootstrapWorkerAfterSpawn();
      }

      const after = await this.getWorkerStatus().catch(() => null);

      return {
        reloaded: true,
        reason: input.reason,
        wasStale,
        droppedSessionCount: input.force ? activeSessionCount : 0,
        oldWorkerProcessId,
        newWorkerProcessId: after?.processId ?? this.worker?.pid ?? null,
        freshness: after?.freshness ?? null
      };
    })();

    try {
      return await this.reloadTask;
    } finally {
      this.reloadTask = null;
    }
  }

  private async getWorkerStatus(): Promise<WorkerServerStatus> {
    const result = await this.requestWorker("tools/call", {
      name: "server_status",
      arguments: {}
    });
    return extractWorkerStatus(result);
  }

  private async bootstrapWorkerAfterSpawn(): Promise<void> {
    await this.requestWorker("initialize", this.initializeParams ?? {
      protocolVersion: DEFAULT_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "pawmemo-supervisor",
        version: "0.1.0"
      }
    });

    if (this.initializedNotificationSeen) {
      this.notifyWorker("notifications/initialized");
    }
  }

  private startWorker(): void {
    const entryPointPath = process.argv[1];

    if (!entryPointPath) {
      throw new Error("Unable to resolve the PawMemo CLI entrypoint for MCP worker startup.");
    }

    const child = spawn(
      process.execPath,
      [entryPointPath, ...process.argv.slice(2)],
      {
        env: {
          ...process.env,
          [WORKER_ENV_FLAG]: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.worker = child;
    this.workerStartedAtMs = Date.now();
    this.workerStdoutBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      this.onWorkerStdout(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.write(chunk);
    });

    child.once("exit", (code, signal) => {
      const message =
        code === 0 || signal === "SIGTERM"
          ? "PawMemo MCP worker exited."
          : `PawMemo MCP worker exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
      const error = new Error(message);

      this.worker = null;
      this.workerStartedAtMs = null;
      this.rejectAllPendingWorkerRequests(error);
    });
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return;
    }

    await new Promise<void>((resolve) => {
      worker.once("exit", () => resolve());
      worker.kill("SIGTERM");
    });
  }

  private rejectAllPendingWorkerRequests(error: Error): void {
    const pending = [...this.pendingWorkerRequests.values()];
    this.pendingWorkerRequests.clear();
    this.workerRequestByClientId.clear();
    this.cancelledClientRequests.clear();

    for (const entry of pending) {
      entry.reject(error);
    }
  }

  private notifyWorker(method: string, params?: unknown): void {
    if (!this.worker || !this.worker.stdin.writable) {
      return;
    }

    this.worker.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  private async requestWorker(
    method: string,
    params?: unknown,
    options: {
      clientRequestId?: JsonRpcId;
    } = {}
  ): Promise<unknown> {
    await this.ensureWorkerReady();

    const worker = this.worker;
    if (!worker || !worker.stdin.writable) {
      throw new Error("PawMemo MCP worker is not available.");
    }

    const workerRequestId = `worker-${this.nextWorkerRequestId++}`;

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingWorkerRequests.set(workerRequestId, {
        method,
        resolve,
        reject
      });
    });

    const clientRequestId = options.clientRequestId;
    if (clientRequestId !== undefined && clientRequestId !== null) {
      if (this.cancelledClientRequests.delete(clientRequestId)) {
        throw new DOMException("Request cancelled.", "AbortError");
      }

      this.workerRequestByClientId.set(clientRequestId, workerRequestId);

      if (this.cancelledClientRequests.delete(clientRequestId)) {
        this.workerRequestByClientId.delete(clientRequestId);
        throw new DOMException("Request cancelled.", "AbortError");
      }
    }

    worker.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: workerRequestId,
        method,
        params
      })}\n`
    );

    try {
      return await promise;
    } finally {
      this.pendingWorkerRequests.delete(workerRequestId);
      if (clientRequestId !== undefined && clientRequestId !== null) {
        const activeWorkerRequestId = this.workerRequestByClientId.get(clientRequestId);
        if (activeWorkerRequestId === workerRequestId) {
          this.workerRequestByClientId.delete(clientRequestId);
        }
      }
    }
  }

  private cancelClientRequest(clientRequestId: unknown): void {
    if (
      (typeof clientRequestId !== "string" && typeof clientRequestId !== "number") ||
      !this.worker
    ) {
      return;
    }

    const workerRequestId = this.workerRequestByClientId.get(clientRequestId);
    if (!workerRequestId) {
      this.cancelledClientRequests.add(clientRequestId);
      return;
    }

    const pending = this.pendingWorkerRequests.get(workerRequestId);
    if (pending) {
      this.pendingWorkerRequests.delete(workerRequestId);
      pending.reject(new DOMException("Request cancelled.", "AbortError"));
    }

    this.workerRequestByClientId.delete(clientRequestId);

    this.notifyWorker("notifications/cancelled", {
      requestId: workerRequestId,
      reason: "Request cancelled by supervisor."
    });
  }

  private onWorkerStdout(chunk: string): void {
    this.workerStdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.workerStdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.workerStdoutBuffer.slice(0, newlineIndex).trim();
      this.workerStdoutBuffer = this.workerStdoutBuffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      let message: JsonRpcSuccessResponse | JsonRpcErrorResponse;
      try {
        message = JSON.parse(line) as JsonRpcSuccessResponse | JsonRpcErrorResponse;
      } catch {
        stderr.write(`Invalid JSON from PawMemo MCP worker: ${line}\n`);
        continue;
      }

      const pending = this.pendingWorkerRequests.get(String(message.id));
      if (!pending) {
        continue;
      }

      if ("error" in message) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        continue;
      }

      pending.resolve(message.result);
    }
  }
}

export function isShellMcpWorkerProcess(): boolean {
  return process.env[WORKER_ENV_FLAG] === "1";
}

export async function runShellMcpSupervisor(
  options: McpServerOptions = {}
): Promise<void> {
  const supervisor = new PawMemoShellMcpSupervisor(options);
  const lines = createInterface({
    input,
    crlfDelay: Infinity
  });
  const activeTasks = new Set<Promise<void>>();

  const trackTask = (task: Promise<void>): void => {
    activeTasks.add(task);
    void task.finally(() => {
      activeTasks.delete(task);
    });
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
        trackTask(supervisor.handleRequest(request));
        continue;
      }

      await supervisor.handleRequest(request);
    }
  } finally {
    lines.close();

    if (activeTasks.size > 0) {
      await Promise.allSettled([...activeTasks]);
    }

    await supervisor.shutdown().catch((error: unknown) => {
      if (error instanceof Error) {
        stderr.write(`${error.message}\n`);
      }
    });
  }
}
