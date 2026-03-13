import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { CliDataKind } from "./theme";
import { createCliTheme, shouldUseColor } from "./theme";
import type { ReviewSessionTerminal } from "./review-session-runner";
import type { StudyCellIntent } from "./transcript-intent";
import {
  ShellTranscriptModel,
  type ShellStudyCellPayload,
  type ShellTranscriptCell
} from "./shell-transcript";

const SHELL_STREAM_DELAY_MS = 18;
const SHELL_WAIT_FRAME_MS = 250;
const DEFAULT_SHELL_PROMPT = "paw> ";
const WAITING_FRAMES = ["[U.  ]", "[ U. ]", "[  U.]", "[ U. ]"];
const ANSI_CLEAR_LINE = "\r\u001b[2K";
const ANSI_CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ANSI_ALT_SCREEN_ON = "\u001b[?1049h";
const ANSI_ALT_SCREEN_OFF = "\u001b[?1049l";
const ANSI_HIDE_CURSOR = "\u001b[?25l";
const ANSI_SHOW_CURSOR = "\u001b[?25h";
const ANSI_MOUSE_TRACKING_ON = "";
const ANSI_MOUSE_TRACKING_OFF = "";
const DEFAULT_TUI_COLUMNS = 80;
const DEFAULT_TUI_ROWS = 24;
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_REGEX = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");
const CURSOR_GLYPH = "█";

type ShellSurfaceEntryInput = {
  kind: ShellTranscriptCell["kind"];
  text: string;
  dataKind?: CliDataKind;
  study?: ShellStudyCellPayload;
};

export interface ShellTerminal extends ReviewSessionTerminal {
  writeRaw?(text: string): void;
}

export class ReadlineShellTerminal implements ShellTerminal {
  readonly supportsColor = shouldUseColor(output);

  private readonly readline = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY)
  });

  write(text: string): void {
    output.write(`${text}\n`);
  }

  writeRaw(text: string): void {
    output.write(text);
  }

  prompt(promptText: string): Promise<string> {
    return this.readline.question(promptText);
  }

  close(): void {
    this.readline.close();
  }
}

export interface ShellSurface {
  readonly supportsColor?: boolean;
  beginShell(displayName: string): void;
  close(): Promise<void> | void;
  prompt(): Promise<string>;
  seedTranscript?(entries: ShellSurfaceEntryInput[]): void;
  renderCompanionCard(text: string): void;
  renderCompanionLine(text: string): void;
  showWaitingIndicator(label: string, text: string): void;
  clearWaitingIndicator(): void;
  writeAssistantReply(text: string): Promise<void>;
  writeAssistantReplyNow(text: string): void;
  writeHelp(text: string): void;
  writeDataBlock(
    text: string,
    kind?: CliDataKind,
    study?: StudyCellIntent
  ): void;
  createReviewSessionTerminal(): ReviewSessionTerminal;
  close(): Promise<void> | void;
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0 ||
    codePoint === 0x200d ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) {
    return 2;
  }

  return 1;
}

function stringDisplayWidth(text: string): number {
  let width = 0;

  for (const char of text) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }

  return width;
}

function visibleDisplayWidth(text: string): number {
  return stringDisplayWidth(text.replace(ANSI_REGEX, ""));
}

function wrapDisplayText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\t/g, "  ");

  if (maxWidth <= 0) {
    return [normalized];
  }

  if (normalized.trim().length === 0) {
    return [""];
  }

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;

    if (stringDisplayWidth(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      lines.push(current);
      current = word;
      continue;
    }

    let chunk = "";
    for (const char of word) {
      const chunkCandidate = `${chunk}${char}`;
      if (stringDisplayWidth(chunkCandidate) <= maxWidth) {
        chunk = chunkCandidate;
      } else {
        if (chunk.length > 0) {
          lines.push(chunk);
        }
        chunk = char;
      }
    }
    current = chunk;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [normalized];
}

function tokenizeComposerInput(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < value.length) {
    const remaining = value.slice(index);

    if (remaining.startsWith("\u001b[3~")) {
      tokens.push("\u001b[3~");
      index += 4;
      continue;
    }

    const mouseMatch = remaining.match(/^\u001b\[<[0-9;]+[mM]/);
    if (mouseMatch) {
      tokens.push(mouseMatch[0] as string);
      index += (mouseMatch[0] as string).length;
      continue;
    }

    if (
      remaining.startsWith("\u001b[D") ||
      remaining.startsWith("\u001b[C") ||
      remaining.startsWith("\u001b[H") ||
      remaining.startsWith("\u001b[F") ||
      remaining.startsWith("\u001bOH") ||
      remaining.startsWith("\u001bOF")
    ) {
      tokens.push(remaining.slice(0, 3));
      index += 3;
      continue;
    }

    tokens.push(value[index] ?? "");
    index += 1;
  }

  return tokens.filter((token) => token.length > 0);
}

export class LineShellSurface implements ShellSurface {
  readonly supportsColor?: boolean;

  private readonly theme: ReturnType<typeof createCliTheme>;
  private waitingFrame = 0;
  private waitingText: string | null = null;
  private waitingLabel: string | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly terminal: ShellTerminal) {
    this.supportsColor = terminal.supportsColor;
    this.theme = createCliTheme({
      enabled: terminal.supportsColor ?? false
    });
  }

  beginShell(displayName: string): void {
    this.terminal.write(this.theme.heading(`PawMemo shell (${displayName})`));
    this.terminal.write(
      this.theme.muted("Talk to me naturally. If adding a word feels uncertain, I'll ask before I save it.")
    );
  }

  prompt(): Promise<string> {
    return this.terminal.prompt(this.theme.prompt(DEFAULT_SHELL_PROMPT));
  }

  renderCompanionCard(text: string): void {
    this.terminal.write(this.theme.companionCard(text));
  }

  renderCompanionLine(text: string): void {
    this.terminal.write(this.theme.companionLine(text));
  }

  showWaitingIndicator(label: string, text: string): void {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.waitingLabel = label;
    this.waitingText = trimmed;
    this.waitingFrame = 0;

    if (!this.terminal.writeRaw) {
      this.terminal.write(this.formatWaitingLine());
      return;
    }

    this.renderWaitingFrame();

    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
    }

    this.waitingTimer = setInterval(() => {
      this.waitingFrame = (this.waitingFrame + 1) % WAITING_FRAMES.length;
      this.renderWaitingFrame();
    }, SHELL_WAIT_FRAME_MS);
  }

  clearWaitingIndicator(): void {
    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
      this.waitingTimer = null;
    }

    if (this.waitingText !== null && this.terminal.writeRaw) {
      this.terminal.writeRaw(ANSI_CLEAR_LINE);
    }

    this.waitingText = null;
    this.waitingLabel = null;
    this.waitingFrame = 0;
  }

  async writeAssistantReply(text: string): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.clearWaitingIndicator();

    if (!this.terminal.writeRaw) {
      this.writeAssistantReplyNow(trimmed);
      return;
    }

    const tokens = /\s/.test(trimmed)
      ? trimmed.match(/\S+\s*/g) ?? [trimmed]
      : [...trimmed];

    for (const token of tokens) {
      this.terminal.writeRaw(this.theme.companionLine(token));
      await new Promise((resolve) => setTimeout(resolve, SHELL_STREAM_DELAY_MS));
    }

    this.terminal.writeRaw("\n");
  }

  writeAssistantReplyNow(text: string): void {
    this.clearWaitingIndicator();
    this.terminal.write(this.theme.companionLine(text));
  }

  writeHelp(text: string): void {
    this.clearWaitingIndicator();
    this.terminal.write(this.theme.help(text));
  }

  writeDataBlock(
    text: string,
    kind: CliDataKind = "plain",
    study?: StudyCellIntent
  ): void {
    void study;
    this.clearWaitingIndicator();
    this.terminal.write(this.theme.dataBlock(text, kind));
  }

  createReviewSessionTerminal(): ReviewSessionTerminal {
    return {
      supportsColor: this.supportsColor,
      write: (text: string) => {
        this.terminal.write(text);
      },
      writeDataBlock: (
        text: string,
        kind: CliDataKind,
        study?: StudyCellIntent
      ) => {
        this.writeDataBlock(text, kind, study);
      },
      prompt: (promptText: string) => this.terminal.prompt(promptText),
      close: () => {}
    };
  }

  close(): Promise<void> | void {
    this.clearWaitingIndicator();
    return this.terminal.close();
  }

  private renderWaitingFrame(): void {
    if (!this.terminal.writeRaw || this.waitingText === null) {
      return;
    }

    this.terminal.writeRaw(
      `${ANSI_CLEAR_LINE}${this.formatWaitingLine()}`
    );
  }

  private formatWaitingLine(): string {
    const frame = WAITING_FRAMES[this.waitingFrame] ?? WAITING_FRAMES[0] ?? "•";
    const label = this.waitingLabel ? ` ${this.waitingLabel}` : "";
    return this.theme.status(`${frame}${label}  ${this.waitingText ?? ""}`);
  }
}

export class TuiShellSurface implements ShellSurface {
  readonly supportsColor?: boolean;

  private readonly theme: ReturnType<typeof createCliTheme>;
  private readonly transcript = new ShellTranscriptModel();
  private waitingFrame = 0;
  private waitingLabel: string | null = null;
  private waitingText: string | null = null;
  private waitingSince: number | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private activePromptLabel = DEFAULT_SHELL_PROMPT;
  private composerBuffer = "";
  private composerCursor = 0;
  private transcriptScrollOffset = 0;
  private displayName = "PawMemo";
  private introText =
    "Talk to me naturally. If adding a word feels uncertain, I'll ask before I save it.";
  private active = false;

  constructor(private readonly terminal: ShellTerminal) {
    this.supportsColor = terminal.supportsColor;
    this.theme = createCliTheme({
      enabled: terminal.supportsColor ?? false
    });
  }

  seedTranscript(entries: ShellSurfaceEntryInput[]): void {
    for (const entry of entries) {
      this.transcript.appendCommittedCell(
        entry.kind,
        entry.text,
        entry.dataKind,
        entry.study
      );
    }
    this.transcriptScrollOffset = 0;
    this.renderFrame();
  }

  beginShell(displayName: string): void {
    this.displayName = displayName;
    this.active = true;
    this.terminal.writeRaw?.(
      `${ANSI_ALT_SCREEN_ON}${ANSI_MOUSE_TRACKING_ON}${ANSI_HIDE_CURSOR}${ANSI_CLEAR_SCREEN}`
    );
    this.renderFrame();
  }

  prompt(): Promise<string> {
    return this.promptWithLabel(DEFAULT_SHELL_PROMPT);
  }

  renderCompanionCard(text: string): void {
    this.appendEntry({ kind: "companion-card", text });
  }

  renderCompanionLine(text: string): void {
    this.appendEntry({ kind: "companion-line", text });
  }

  showWaitingIndicator(label: string, text: string): void {
    if (text.trim().length === 0) {
      return;
    }

    this.waitingLabel = label;
    this.waitingText = text.trim();
    this.waitingSince = Date.now();
    this.waitingFrame = 0;
    this.renderFrame();

    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
    }

    this.waitingTimer = setInterval(() => {
      this.waitingFrame = (this.waitingFrame + 1) % WAITING_FRAMES.length;
      this.renderFrame();
    }, SHELL_WAIT_FRAME_MS);
  }

  clearWaitingIndicator(): void {
    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
      this.waitingTimer = null;
    }
    if (this.waitingLabel !== null || this.waitingText !== null) {
      this.waitingLabel = null;
      this.waitingText = null;
      this.waitingSince = null;
      this.waitingFrame = 0;
      this.renderFrame();
    }
  }

  async writeAssistantReply(text: string): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.clearWaitingIndicator();
    this.transcript.beginActiveAssistantCell();
    this.renderFrame();

    const tokens = /\s/.test(trimmed)
      ? trimmed.match(/\S+\s*/g) ?? [trimmed]
      : [...trimmed];

    for (const token of tokens) {
      this.transcript.appendActiveAssistantDelta(token);
      this.renderFrame();
      await new Promise((resolve) => setTimeout(resolve, SHELL_STREAM_DELAY_MS));
    }

    this.transcript.commitActiveCell();
    this.renderFrame();
  }

  writeAssistantReplyNow(text: string): void {
    this.clearWaitingIndicator();
    this.appendEntry({ kind: "assistant", text });
  }

  writeHelp(text: string): void {
    this.clearWaitingIndicator();
    this.appendEntry({ kind: "help", text });
  }

  writeDataBlock(
    text: string,
    kind: CliDataKind = "plain",
    study?: StudyCellIntent
  ): void {
    this.clearWaitingIndicator();
    this.appendEntry({
      kind: "data",
      text,
      dataKind: kind,
      study: study ?? this.inferStudyCell(text, kind)
    });
  }

  createReviewSessionTerminal(): ReviewSessionTerminal {
    return {
      supportsColor: this.supportsColor,
      write: (text: string) => {
        this.appendEntry({
          kind: "data",
          text,
          dataKind: "plain",
          study: this.inferStudyCell(text, "plain")
        });
      },
      writeDataBlock: (
        text: string,
        kind: CliDataKind,
        study?: StudyCellIntent
      ) => {
        this.writeDataBlock(text, kind, study);
      },
      prompt: (promptText: string) => this.promptWithLabel(promptText),
      close: () => {}
    };
  }

  close(): Promise<void> | void {
    this.clearWaitingIndicator();
    if (this.active) {
      this.terminal.writeRaw?.(`${ANSI_SHOW_CURSOR}${ANSI_MOUSE_TRACKING_OFF}${ANSI_ALT_SCREEN_OFF}`);
      this.active = false;
    }
    return this.terminal.close();
  }

  private appendEntry(entry: ShellSurfaceEntryInput): void {
    this.transcript.appendCommittedCell(
      entry.kind,
      entry.text,
      entry.dataKind,
      entry.study
    );
    this.transcriptScrollOffset = 0;
    this.renderFrame();
  }

  private async promptWithLabel(promptText: string): Promise<string> {
    this.activePromptLabel = promptText;
    this.composerBuffer = "";
    this.composerCursor = 0;
    this.renderFrame();

    try {
      if (this.canUseInlineComposer()) {
        return await this.promptWithInlineComposer();
      }

      return await this.terminal.prompt("");
    } finally {
      this.activePromptLabel = DEFAULT_SHELL_PROMPT;
      this.renderFrame();
    }
  }

  private canUseInlineComposer(): boolean {
    return Boolean(
      this.terminal.writeRaw &&
      process.stdin.isTTY &&
      typeof process.stdin.setRawMode === "function"
    );
  }

  private async promptWithInlineComposer(): Promise<string> {
    const stdin = process.stdin;
    const previousRawMode = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();

    let streamBuffer = "";

    return await new Promise<string>((resolve) => {
      const onData = (chunk: Buffer | string): void => {
        streamBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

        // Continuously extract complete tokens from the streamBuffer
        while (streamBuffer.length > 0) {
          // 1. Check for complete or partial escape sequences
          if (streamBuffer.startsWith("\u001b")) {
            // Known complete sequences
            if (streamBuffer.startsWith("\u001b[3~")) {
              this.deleteAfterCursor();
              streamBuffer = streamBuffer.slice(4);
              continue;
            }

            const mouseMatch = streamBuffer.match(/^\u001b\[<([0-9;]+)[mM]/);
            if (mouseMatch) {
              const fullMatch = mouseMatch[0] as string;
              if (fullMatch.startsWith("\u001b[<64;")) {
                this.scrollTranscriptUp();
              } else if (fullMatch.startsWith("\u001b[<65;")) {
                this.scrollTranscriptDown();
              }
              // Ignore other mouse clicks or drags
              streamBuffer = streamBuffer.slice(fullMatch.length);
              continue;
            }

            const csiMatch = streamBuffer.match(/^\u001b\[[0-9;]*[a-zA-Z]/);
            if (csiMatch) {
                const fullMatch = csiMatch[0] as string;
                switch (fullMatch) {
                    case "\u001b[D": this.moveCursorLeft(); break;
                    case "\u001b[C": this.moveCursorRight(); break;
                    case "\u001b[H": this.moveCursorHome(); break;
                    case "\u001b[F": this.moveCursorEnd(); break;
                    case "\u001b[5~": this.scrollTranscriptUp(10); break;
                    case "\u001b[6~": this.scrollTranscriptDown(10); break;
                    case "\u001b[A": this.scrollTranscriptUp(1); break;
                    case "\u001b[B": this.scrollTranscriptDown(1); break;
                }
                streamBuffer = streamBuffer.slice(fullMatch.length);
                continue;
            }

            const ss3Match = streamBuffer.match(/^\u001bO[a-zA-Z]/);
            if (ss3Match) {
                const fullMatch = ss3Match[0] as string;
                switch (fullMatch) {
                    case "\u001bOH": this.moveCursorHome(); break;
                    case "\u001bOF": this.moveCursorEnd(); break;
                }
                streamBuffer = streamBuffer.slice(fullMatch.length);
                continue;
            }

            // If it starts with ESC but doesn't match a complete sequence,
            // we must wait for more data to arrive in the next chunk.
            // If the buffer is getting too long (e.g. garbage), flush it.
            if (streamBuffer.length < 16) {
                break;
            } else {
                streamBuffer = streamBuffer.slice(1);
                continue;
            }
          }

          // 2. Process regular characters
          const token = streamBuffer[0] as string;
          streamBuffer = streamBuffer.slice(1);

          switch (token) {
            case "\r":
            case "\n": {
              cleanup();
              const submitted = this.composerBuffer;
              this.composerBuffer = "";
              this.composerCursor = 0;
              this.transcriptScrollOffset = 0;
              this.renderFrame();
              resolve(submitted);
              return;
            }
            case "\u0003": {
              cleanup();
              this.composerBuffer = "/quit";
              this.composerCursor = 0;
              this.transcriptScrollOffset = 0;
              this.renderFrame();
              resolve("/quit");
              return;
            }
            case "\u007f":
            case "\b": {
              this.deleteBeforeCursor();
              break;
            }
            case "\u001b": {
                // This shouldn't happen in the loop because we check startsWithESC above,
                // but if an ESC is stuck, skip it to avoid breaking the input.
                break;
            }
            default: {
              this.insertAtCursor(token);
            }
          }
        }
      };

      const cleanup = (): void => {
        stdin.off("data", onData);
        stdin.setRawMode?.(previousRawMode ?? false);
      };

      stdin.on("data", onData);
    });
  }

  private insertAtCursor(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor)}${text}${this.composerBuffer.slice(this.composerCursor)}`;
    this.composerCursor += text.length;
    this.transcriptScrollOffset = 0;
    this.renderFrame();
  }

  private deleteBeforeCursor(): void {
    if (this.composerCursor <= 0) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor - 1)}${this.composerBuffer.slice(this.composerCursor)}`;
    this.composerCursor -= 1;
    this.renderFrame();
  }

  private deleteAfterCursor(): void {
    if (this.composerCursor >= this.composerBuffer.length) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor)}${this.composerBuffer.slice(this.composerCursor + 1)}`;
    this.renderFrame();
  }

  private scrollTranscriptUp(count = 3): void {
    this.transcriptScrollOffset += count;
    this.renderFrame();
  }

  private scrollTranscriptDown(count = 3): void {
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset - count);
    this.renderFrame();
  }

  private moveCursorLeft(): void {
    if (this.composerCursor <= 0) {
      return;
    }

    this.composerCursor -= 1;
    this.renderFrame();
  }

  private moveCursorRight(): void {
    if (this.composerCursor >= this.composerBuffer.length) {
      return;
    }

    this.composerCursor += 1;
    this.renderFrame();
  }

  private moveCursorHome(): void {
    this.composerCursor = 0;
    this.renderFrame();
  }

  private moveCursorEnd(): void {
    this.composerCursor = this.composerBuffer.length;
    this.renderFrame();
  }

  private renderFrame(): void {
    if (!this.terminal.writeRaw || !this.active) {
      return;
    }

    const columns = process.stdout.columns ?? DEFAULT_TUI_COLUMNS;
    const rows = process.stdout.rows ?? DEFAULT_TUI_ROWS;
    const headerLines = this.renderHeader(columns);
    const tipLines = this.renderTip(columns);
    const statusHeight = 1;
    const composerLines = this.renderComposer(columns);
    const footerLines = this.renderFooter();
    const occupiedHeight =
      headerLines.length +
      tipLines.length +
      statusHeight +
      composerLines.length +
      footerLines.length;
    const transcriptHeight = Math.max(
      4,
      rows - occupiedHeight
    );

    const statusLine = this.renderStatusLine(columns);
    const transcriptLines = this.renderTranscript(columns, transcriptHeight);

    const frame = [
      ...headerLines,
      ...tipLines,
      ...transcriptLines,
      statusLine,
      ...composerLines
      ,
      ...footerLines
    ]
      .slice(0, rows)
      .join("\n");

    this.terminal.writeRaw(`${ANSI_CLEAR_SCREEN}${frame}`);
  }

  private renderTranscript(columns: number, height: number): string[] {
    const snapshot = this.transcript.snapshot();
    const rendered = snapshot.committedCells.flatMap((cell) =>
      this.renderCellLines(cell, columns)
    );

    if (snapshot.activeCell && snapshot.activeCell.text.trim().length > 0) {
      rendered.push(...this.renderCellLines({
        id: 0,
        kind: snapshot.activeCell.kind,
        text: snapshot.activeCell.text
      }, columns));
    }

    if (rendered.length === 0) {
      rendered.push(
        this.theme.muted(
          this.fitLine(
            "No messages yet. Start with a word, a question, /review, or /rescue.",
            columns
          )
        )
      );
    }

    const innerHeight = Math.max(1, height);
    const maxScroll = Math.max(0, rendered.length - innerHeight);
    this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));

    const endIndex = rendered.length - this.transcriptScrollOffset;
    const startIndex = Math.max(0, endIndex - innerHeight);
    const tail = rendered.slice(startIndex, endIndex);

    const padding = Array.from(
      { length: Math.max(0, innerHeight - tail.length) },
      () => ""
    );

    return [...tail, ...padding];
  }

  private renderCellLines(entry: ShellTranscriptCell, columns: number): string[] {
    const maxWidth = Math.max(12, columns);
    const sourceLines = entry.text.split("\n");
    const output: string[] = [];

    sourceLines.forEach((sourceLine, sourceIndex) => {
      const wrappedLines = wrapDisplayText(sourceLine, maxWidth);

      wrappedLines.forEach((line, wrappedIndex) => {
        switch (entry.kind) {
          case "companion-card":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? `${this.theme.heading("•")} ${this.theme.heading(line)}`
                : `  ${line}`
            );
            break;
          case "companion-line":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? `${this.theme.companionLine("•")} ${this.theme.companionLine(line)}`
                : `  ${this.theme.companionLine(line)}`
            );
            break;
          case "assistant":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? `${this.theme.status("•")} ${line}`
                : `  ${line}`
            );
            break;
          case "user-line":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? `${this.theme.prompt("›")} ${line}`
                : `  ${line}`
            );
            break;
          case "help":
            output.push(
                sourceIndex === 0 && wrappedIndex === 0
                  ? `${this.theme.muted("?")} ${this.theme.muted(line)}`
                  : `  ${this.theme.muted(line)}`
            );
            break;
          case "data":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? (entry.study ? this.renderStudyLine(entry.study, line, sourceIndex, wrappedIndex) : `  ${line}`)
                : `  ${line}`
            );
            break;
        }
      });
    });

    return output;
  }

  private renderStatusLine(columns: number): string {
    if (this.waitingText === null) {
      return this.theme.muted(
        this.fitLine(
          "Status  Ready. Natural chat, /review, /rescue, /model, /quit.",
          columns
        )
      );
    }

    return this.theme.status(
      this.fitLine(
        `Status  ${WAITING_FRAMES[this.waitingFrame] ?? "•"} ${this.waitingLabel ?? "PawMemo"}  ${this.waitingText}`,
        columns
      )
    );
  }

  private renderStudyLine(
    study: ShellStudyCellPayload,
    line: string,
    sourceIndex: number,
    wrappedIndex: number
  ): string {
    const isFirstLine = sourceIndex === 0 && wrappedIndex === 0;

    switch (study.kind) {
      case "review-intro":
      case "rescue-intro":
        return isFirstLine
          ? `${this.theme.status("•")} ${this.theme.heading(line)}`
          : `  ${this.theme.muted(line)}`;
      case "review-card":
        if (isFirstLine) {
          return `${this.theme.status("•")} ${this.theme.status(line)}`;
        }

        if (study.emphasis && line.includes(study.emphasis)) {
          return `  ${this.theme.prompt(line)}`;
        }

        return `  ${line}`;
      case "review-summary":
        return isFirstLine ? `${this.theme.status("•")} ${this.theme.heading(line)}` : `  ${line}`;
      default:
        return isFirstLine ? `${this.theme.status("•")} ${line}` : `  ${line}`;
    }
  }

  private inferStudyCell(
    text: string,
    kind: CliDataKind
  ): ShellStudyCellPayload | undefined {
    if (kind === "review-session-heading") {
      return {
        kind: "review-intro",
        title: "review"
      };
    }

    if (kind === "review-card-heading" || /^First up: |^Next up: /.test(text)) {
      return {
        kind: "review-card",
        title: "card",
        emphasis: "What we were looking for:"
      };
    }

    if (
      kind === "review-session-status-success" ||
      kind === "review-session-status-warning" ||
      kind === "review-summary"
    ) {
      return {
        kind: "review-summary",
        title: "summary"
      };
    }

    if (kind === "rescue" || /^We'll rescue /.test(text)) {
      return {
        kind: "rescue-intro",
        title: "rescue"
      };
    }

    return undefined;
  }

  private renderComposer(columns: number): string[] {
    const composerLine = this.renderComposerInput(columns);
    return [
      this.theme.muted("─".repeat(columns)),
      this.theme.muted(
        this.fitLine(
          "Enter to send  ·  /quit to leave",
          columns
        )
      ),
      composerLine
    ];
  }

  private renderHeader(columns: number): string[] {
    return [
      this.theme.heading(`PawMemo Shell (${this.displayName})`),
      this.theme.muted(
        this.fitLine("conversation-first companion", columns)
      ),
      ""
    ];
  }

  private renderTip(columns: number): string[] {
    return [];
  }

  private renderFooter(): string[] {
    return [];
  }

  private renderComposerInput(columns: number): string {
    const prompt = `${this.activePromptLabel}`;
    const cursor = Math.max(0, Math.min(this.composerCursor, this.composerBuffer.length));
    const rawContent =
      `${this.composerBuffer.slice(0, cursor)}${CURSOR_GLYPH}${this.composerBuffer.slice(cursor)}`;
    const maxContentWidth = Math.max(1, columns - visibleDisplayWidth(prompt));
    const visibleContent = this.tailDisplayText(rawContent, maxContentWidth);
    return `${this.theme.prompt(prompt)}${visibleContent}`;
  }

  private tailDisplayText(text: string, maxWidth: number): string {
    if (stringDisplayWidth(text) <= maxWidth) {
      return text;
    }

    let out = "";
    const reversed = [...text].reverse();

    for (const char of reversed) {
      const candidate = `${char}${out}`;
      if (stringDisplayWidth(candidate) > maxWidth - 1) {
        break;
      }
      out = candidate;
    }

    return `…${out}`;
  }



  private fitLine(text: string, columns: number): string {
    if (stringDisplayWidth(text) <= columns) {
      return text;
    }

    let out = "";
    for (const char of text) {
      const candidate = `${out}${char}`;
      if (stringDisplayWidth(`${candidate}…`) > columns) {
        break;
      }
      out = candidate;
    }

    return `${out}…`;
  }
}
