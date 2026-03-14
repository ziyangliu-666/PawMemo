import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { nowIso } from "../lib/time";
import { ShellRunner } from "./shell-runner";
import {
  TuiShellSurface,
  type ShellExternalKey,
  type ShellTerminal
} from "./shell-surface";
import type { ShellFrameSnapshot } from "./shell-frame-snapshot";
import { openDatabase, type SqliteDatabase } from "../storage/sqlite/database";
import { renderShellSnapshotToPng } from "./shell-image-renderer";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_CAPACITY = 100;
const WAIT_POLL_MS = 20;
const SVG_CELL_WIDTH = 9;
const SVG_LINE_HEIGHT = 18;
const SVG_PADDING_X = 14;
const SVG_PADDING_Y = 18;

class HarnessShellTerminal implements ShellTerminal {
  readonly supportsColor = true;
  private viewport = {
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS
  };

  readonly writes: string[] = [];
  readonly rawWrites: string[] = [];
  readonly prompts: string[] = [];

  write(text: string): void {
    this.writes.push(text);
  }

  writeRaw(text: string): void {
    this.rawWrites.push(text);
  }

  async prompt(promptText: string): Promise<string> {
    this.prompts.push(promptText);
    return await Promise.resolve("/quit");
  }

  close(): void {}

  getViewportSize(): { columns: number; rows: number } {
    return { ...this.viewport };
  }

  setViewportSize(columns: number, rows: number): void {
    this.viewport = {
      columns,
      rows
    };
  }
}

export interface ShellHarnessOptions {
  dbPath?: string;
  packId?: string;
  debug?: boolean;
  columns?: number;
  rows?: number;
}

export interface ShellHarnessSnapshot {
  sessionId: string;
  snapshotId: string;
  createdAt: string;
  promptPending: boolean;
  frame: ShellFrameSnapshot;
}

export interface ShellHarnessLineDiff {
  index: number;
  from: string;
  to: string;
}

export interface ShellHarnessRegionDiff {
  region:
    | "header"
    | "tip"
    | "transcript"
    | "status"
    | "composer"
    | "footer";
  changedLines: ShellHarnessLineDiff[];
}

export interface ShellHarnessDiff {
  sessionId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  changedRegions: ShellHarnessRegionDiff[];
  transcriptCellIdsAdded: number[];
  transcriptCellIdsRemoved: number[];
  promptPendingChanged: boolean;
  companionLineChanged: boolean;
  waitingChanged: boolean;
  interruptHintChanged: boolean;
}

export interface ShellHarnessExportResult {
  sessionId: string;
  snapshotId: string;
  format: "txt" | "json" | "svg" | "png";
  path: string;
}

export interface ShellHarnessSnapshotSummary {
  snapshotId: string;
  createdAt: string;
  promptPending: boolean;
  promptEpoch: number;
  waiting: boolean;
  committedCellCount: number;
}

export interface ShellHarnessSessionSummary {
  sessionId: string;
  createdAt: string;
  snapshotCount: number;
  snapshotCapacity: number;
  latestSnapshotId: string | null;
  latestSnapshotCreatedAt: string | null;
  displayName: string;
  shellMode: string;
  dueCount: number;
  viewport: {
    columns: number;
    rows: number;
  };
  promptPending: boolean;
  promptEpoch: number;
  waiting: boolean;
}

export type ShellHarnessWaitCondition =
  | "prompt"
  | "next-prompt"
  | "snapshot-change";

export interface ShellHarnessWaitResult {
  sessionId: string;
  condition: ShellHarnessWaitCondition;
  sinceSnapshotId: string | null;
  elapsedMs: number;
  snapshot: ShellHarnessSnapshot;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function createLineDiffs(fromLines: string[], toLines: string[]): ShellHarnessLineDiff[] {
  const maxLength = Math.max(fromLines.length, toLines.length);
  const diffs: ShellHarnessLineDiff[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const from = fromLines[index] ?? "";
    const to = toLines[index] ?? "";

    if (from !== to) {
      diffs.push({
        index,
        from,
        to
      });
    }
  }

  return diffs;
}

function framesDiffer(
  from: ShellFrameSnapshot,
  to: ShellFrameSnapshot
): boolean {
  return JSON.stringify(from) !== JSON.stringify(to);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  throw new DOMException("The operation was aborted.", "AbortError");
}

async function waitWithAbort(
  delayMs: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (signal?.reason instanceof Error) {
        reject(signal.reason);
        return;
      }

      reject(new DOMException("The operation was aborted.", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class PawMemoShellHarness {
  readonly sessionId = randomUUID();
  readonly createdAt = nowIso();
  readonly snapshotCapacity = DEFAULT_SNAPSHOT_CAPACITY;

  private readonly db: SqliteDatabase;
  private readonly terminal = new HarnessShellTerminal();
  private readonly surface: TuiShellSurface;
  private readonly runner: ShellRunner;
  private runPromise: Promise<void> | null = null;
  private snapshotCounter = 0;
  private latestSnapshotId: string | null = null;
  private readonly snapshots = new Map<string, ShellHarnessSnapshot>();

  constructor(options: ShellHarnessOptions = {}) {
    this.db = openDatabase(options.dbPath);
    this.terminal.setViewportSize(
      Math.max(40, options.columns ?? DEFAULT_COLUMNS),
      Math.max(16, options.rows ?? DEFAULT_ROWS)
    );
    this.surface = new TuiShellSurface(this.terminal, {
      debug: options.debug ?? false,
      inputMode: "external-composer"
    });
    this.runner = new ShellRunner({
      db: this.db,
      terminal: this.terminal,
      surface: this.surface,
      packId: options.packId,
      debug: options.debug ?? false
    });
  }

  async start(signal?: AbortSignal): Promise<ShellHarnessSnapshot> {
    if (!this.runPromise) {
      this.runPromise = this.runner
        .run()
        .finally(() => {
          this.db.close();
        });
    }

    await this.waitForPrompt(undefined, signal);
    return this.snapshot();
  }

  snapshot(): ShellHarnessSnapshot {
    return this.captureSnapshot();
  }

  getLatestSnapshot(): ShellHarnessSnapshot {
    const latestSnapshotId = this.latestSnapshotId;

    if (!latestSnapshotId) {
      return this.captureSnapshot();
    }

    return this.requireSnapshot(latestSnapshotId);
  }

  getSnapshotById(snapshotId: string): ShellHarnessSnapshot {
    return this.requireSnapshot(snapshotId);
  }

  listSnapshotSummaries(): ShellHarnessSnapshotSummary[] {
    return [...this.snapshots.values()].map((snapshot) => ({
      snapshotId: snapshot.snapshotId,
      createdAt: snapshot.createdAt,
      promptPending: snapshot.promptPending,
      promptEpoch: snapshot.frame.composer.promptEpoch,
      waiting: snapshot.frame.waiting !== null,
      committedCellCount: snapshot.frame.transcript.committedCells.length
    }));
  }

  getSessionSummary(): ShellHarnessSessionSummary {
    const latestSnapshot = this.latestSnapshotId
      ? this.requireSnapshot(this.latestSnapshotId)
      : null;
    const frame = latestSnapshot?.frame ?? this.surface.getFrameSnapshot();

    return {
      sessionId: this.sessionId,
      createdAt: this.createdAt,
      snapshotCount: this.snapshots.size,
      snapshotCapacity: this.snapshotCapacity,
      latestSnapshotId: latestSnapshot?.snapshotId ?? null,
      latestSnapshotCreatedAt: latestSnapshot?.createdAt ?? null,
      displayName: frame.displayName,
      shellMode: frame.shellMode,
      dueCount: frame.dueCount,
      viewport: frame.viewport,
      promptPending: frame.composer.promptArmed,
      promptEpoch: frame.composer.promptEpoch,
      waiting: frame.waiting !== null
    };
  }

  async submit(
    input: string,
    waitForPrompt = true,
    signal?: AbortSignal
  ): Promise<ShellHarnessSnapshot> {
    throwIfAborted(signal);
    const promptEpoch = this.surface.getFrameSnapshot().composer.promptEpoch;

    if (!this.surface.submitExternalPrompt(input)) {
      throw new Error("Unable to submit prompt into the shell composer.");
    }

    if (waitForPrompt) {
      await this.waitForPromptCycle(promptEpoch, undefined, signal);
    }

    return this.captureSnapshot();
  }

  typeText(text: string): ShellHarnessSnapshot {
    this.surface.applyExternalInput({
      kind: "text",
      text
    });
    return this.captureSnapshot();
  }

  pasteText(text: string): ShellHarnessSnapshot {
    this.surface.applyExternalInput({
      kind: "paste",
      text
    });
    return this.captureSnapshot();
  }

  async pressKey(
    key: ShellExternalKey,
    waitForPrompt = false,
    signal?: AbortSignal
  ): Promise<ShellHarnessSnapshot> {
    throwIfAborted(signal);
    const promptEpoch = this.surface.getFrameSnapshot().composer.promptEpoch;

    this.surface.applyExternalInput({
      kind: "key",
      key
    });

    if (waitForPrompt) {
      await this.waitForPromptCycle(promptEpoch, undefined, signal);
    }

    return this.captureSnapshot();
  }

  resize(columns: number, rows: number): ShellHarnessSnapshot {
    this.terminal.setViewportSize(
      Math.max(40, columns),
      Math.max(16, rows)
    );
    this.surface.refresh();
    return this.captureSnapshot();
  }

  diffSnapshots(
    fromSnapshotId?: string,
    toSnapshotId?: string
  ): ShellHarnessDiff {
    const latest = this.getLatestSnapshot();
    const orderedSnapshots = [...this.snapshots.values()];
    const defaultFrom =
      orderedSnapshots.length >= 2
        ? orderedSnapshots[orderedSnapshots.length - 2]?.snapshotId
        : latest.snapshotId;
    const from = this.requireSnapshot(fromSnapshotId ?? defaultFrom ?? latest.snapshotId);
    const to = this.requireSnapshot(toSnapshotId ?? latest.snapshotId);
    const changedRegions: ShellHarnessRegionDiff[] = [];

    for (const region of ["header", "tip", "transcript", "status", "composer", "footer"] as const) {
      const changedLines = createLineDiffs(
        from.frame.layout[region].lines,
        to.frame.layout[region].lines
      );

      if (changedLines.length > 0) {
        changedRegions.push({
          region,
          changedLines
        });
      }
    }

    const fromIds = new Set(from.frame.transcript.committedCells.map((cell) => cell.id));
    const toIds = new Set(to.frame.transcript.committedCells.map((cell) => cell.id));

    return {
      sessionId: this.sessionId,
      fromSnapshotId: from.snapshotId,
      toSnapshotId: to.snapshotId,
      changedRegions,
      transcriptCellIdsAdded: [...toIds].filter((id) => !fromIds.has(id)),
      transcriptCellIdsRemoved: [...fromIds].filter((id) => !toIds.has(id)),
      promptPendingChanged: from.promptPending !== to.promptPending,
      companionLineChanged: from.frame.companionLine !== to.frame.companionLine,
      waitingChanged:
        JSON.stringify(from.frame.waiting) !== JSON.stringify(to.frame.waiting),
      interruptHintChanged: from.frame.interruptHint !== to.frame.interruptHint
    };
  }

  exportSnapshot(
    format: "txt" | "json" | "svg" | "png",
    snapshotId?: string,
    outputPath?: string
  ): ShellHarnessExportResult {
    const snapshot = snapshotId
      ? this.requireSnapshot(snapshotId)
      : this.getLatestSnapshot();
    const resolvedPath =
      outputPath ??
      path.resolve(
        process.cwd(),
        ".data",
        "shell-snapshots",
        `${this.sessionId}-${snapshot.snapshotId}.${format}`
      );

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    switch (format) {
      case "txt":
        fs.writeFileSync(resolvedPath, `${snapshot.frame.rendered.frameText}\n`, "utf8");
        break;
      case "json":
        fs.writeFileSync(resolvedPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        break;
      case "svg":
        fs.writeFileSync(resolvedPath, this.renderSnapshotSvg(snapshot), "utf8");
        break;
      case "png":
        fs.writeFileSync(resolvedPath, this.renderSnapshotPng(snapshot));
        break;
    }

    return {
      sessionId: this.sessionId,
      snapshotId: snapshot.snapshotId,
      format,
      path: resolvedPath
    };
  }

  async waitFor(
    condition: ShellHarnessWaitCondition,
    options: {
      sinceSnapshotId?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<ShellHarnessWaitResult> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const baselineSnapshot = options.sinceSnapshotId
      ? this.requireSnapshot(options.sinceSnapshotId)
      : this.getLatestSnapshot();
    const baselinePromptEpoch = baselineSnapshot.frame.composer.promptEpoch;

    while (true) {
      throwIfAborted(options.signal);
      const currentFrame = this.surface.getFrameSnapshot();

      switch (condition) {
        case "prompt":
          if (currentFrame.composer.promptArmed) {
            return {
              sessionId: this.sessionId,
              condition,
              sinceSnapshotId: baselineSnapshot.snapshotId,
              elapsedMs: Date.now() - startedAt,
              snapshot: this.captureSnapshot()
            };
          }
          break;
        case "next-prompt":
          if (
            currentFrame.composer.promptArmed &&
            currentFrame.composer.promptEpoch > baselinePromptEpoch
          ) {
            return {
              sessionId: this.sessionId,
              condition,
              sinceSnapshotId: baselineSnapshot.snapshotId,
              elapsedMs: Date.now() - startedAt,
              snapshot: this.captureSnapshot()
            };
          }
          break;
        case "snapshot-change": {
          const latestSnapshotId = this.latestSnapshotId;

          if (
            latestSnapshotId !== null &&
            latestSnapshotId !== baselineSnapshot.snapshotId
          ) {
            return {
              sessionId: this.sessionId,
              condition,
              sinceSnapshotId: baselineSnapshot.snapshotId,
              elapsedMs: Date.now() - startedAt,
              snapshot: this.requireSnapshot(latestSnapshotId)
            };
          }

          if (framesDiffer(baselineSnapshot.frame, currentFrame)) {
            return {
              sessionId: this.sessionId,
              condition,
              sinceSnapshotId: baselineSnapshot.snapshotId,
              elapsedMs: Date.now() - startedAt,
              snapshot: this.captureSnapshot()
            };
          }
          break;
        }
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for shell condition: ${condition}.`);
      }

      await waitWithAbort(WAIT_POLL_MS, options.signal);
    }
  }

  async stop(): Promise<void> {
    if (!this.runPromise) {
      this.db.close();
      return;
    }

    const composer = this.surface.getFrameSnapshot().composer;

    if (composer.promptArmed) {
      if (!this.surface.submitExternalPrompt("/quit")) {
        if (!this.surface.abortActivePrompt()) {
          await Promise.resolve(this.surface.close());
        }
      }
    } else {
      await Promise.resolve(this.surface.close());
    }

    await this.runPromise;
    this.runPromise = null;
  }

  private captureSnapshot(): ShellHarnessSnapshot {
    this.snapshotCounter += 1;
    const frame = this.surface.getFrameSnapshot();

    const snapshot: ShellHarnessSnapshot = {
      sessionId: this.sessionId,
      snapshotId: `snap-${this.snapshotCounter}`,
      createdAt: nowIso(),
      promptPending: frame.composer.promptArmed,
      frame
    };

    this.snapshots.set(snapshot.snapshotId, snapshot);

    while (this.snapshots.size > this.snapshotCapacity) {
      const oldestSnapshotId = this.snapshots.keys().next().value;

      if (!oldestSnapshotId) {
        break;
      }

      this.snapshots.delete(oldestSnapshotId);
    }

    this.latestSnapshotId = snapshot.snapshotId;
    return snapshot;
  }

  private requireSnapshot(snapshotId: string): ShellHarnessSnapshot {
    const snapshot = this.snapshots.get(snapshotId);

    if (!snapshot) {
      throw new Error(`Unknown shell snapshot: ${snapshotId}`);
    }

    return snapshot;
  }

  private renderSnapshotSvg(snapshot: ShellHarnessSnapshot): string {
    const width =
      snapshot.frame.viewport.columns * SVG_CELL_WIDTH + SVG_PADDING_X * 2;
    const height =
      snapshot.frame.viewport.rows * SVG_LINE_HEIGHT + SVG_PADDING_Y * 2;
    const lines = snapshot.frame.rendered.lines;
    const body = lines.map((line, index) => {
      const y = SVG_PADDING_Y + (index + 1) * SVG_LINE_HEIGHT;
      return `<text x="${SVG_PADDING_X}" y="${y}">${escapeXml(line)}</text>`;
    }).join("");

    return [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<rect width="100%" height="100%" fill="#fffaf2" />`,
      `<rect x="6" y="6" width="${width - 12}" height="${height - 12}" rx="10" fill="#fffefb" stroke="#d9cfbf" />`,
      `<g font-family="Menlo, Consolas, 'Liberation Mono', monospace" font-size="14" fill="#2f241b">`,
      body,
      `</g>`,
      `</svg>`
    ].join("");
  }

  private renderSnapshotPng(snapshot: ShellHarnessSnapshot): Buffer {
    return renderShellSnapshotToPng(snapshot);
  }

  private async waitForPrompt(
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now();

    while (!this.surface.getFrameSnapshot().composer.promptArmed) {
      throwIfAborted(signal);

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for the shell prompt.");
      }

      await waitWithAbort(WAIT_POLL_MS, signal);
    }
  }

  private async waitForPromptCycle(
    previousPromptEpoch: number,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now();

    while (true) {
      throwIfAborted(signal);
      const composer = this.surface.getFrameSnapshot().composer;

      if (composer.promptArmed && composer.promptEpoch > previousPromptEpoch) {
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("Timed out waiting for the shell prompt to return.");
      }

      await waitWithAbort(WAIT_POLL_MS, signal);
    }
  }
}
