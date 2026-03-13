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
const SHELL_WAIT_FRAME_MS = 90;
const DEFAULT_SHELL_PROMPT = "paw> ";
const WAITING_FRAMES = ["●", "◦", "•", "◦"];
const ANSI_CLEAR_LINE = "\r\u001b[2K";
const ANSI_CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ANSI_ALT_SCREEN_ON = "\u001b[?1049h";
const ANSI_ALT_SCREEN_OFF = "\u001b[?1049l";
const ANSI_HIDE_CURSOR = "\u001b[?25l";
const ANSI_SHOW_CURSOR = "\u001b[?25h";
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
  prompt(): Promise<string>;
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

  beginShell(displayName: string): void {
    this.displayName = displayName;
    this.active = true;
    this.terminal.writeRaw?.(
      `${ANSI_ALT_SCREEN_ON}${ANSI_HIDE_CURSOR}${ANSI_CLEAR_SCREEN}`
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
      this.terminal.writeRaw?.(`${ANSI_SHOW_CURSOR}${ANSI_ALT_SCREEN_OFF}`);
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

    return await new Promise<string>((resolve) => {
      const onData = (chunk: Buffer | string): void => {
        const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const tokens = tokenizeComposerInput(value);

        for (const token of tokens) {
          switch (token) {
            case "\r":
            case "\n": {
              cleanup();
              const submitted = this.composerBuffer;
              this.composerBuffer = "";
              this.composerCursor = 0;
              this.renderFrame();
              resolve(submitted);
              return;
            }
            case "\u0003": {
              cleanup();
              this.composerBuffer = "/quit";
              this.composerCursor = 0;
              this.renderFrame();
              resolve("/quit");
              return;
            }
            case "\u007f":
            case "\b": {
              this.deleteBeforeCursor();
              break;
            }
            case "\u001b[D": {
              this.moveCursorLeft();
              break;
            }
            case "\u001b[C": {
              this.moveCursorRight();
              break;
            }
            case "\u001b[H":
            case "\u001bOH": {
              this.moveCursorHome();
              break;
            }
            case "\u001b[F":
            case "\u001bOF": {
              this.moveCursorEnd();
              break;
            }
            case "\u001b[3~": {
              this.deleteAfterCursor();
              break;
            }
            default: {
              if (token.startsWith("\u001b")) {
                break;
              }

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
    const footerLines = this.renderFooter(columns);
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
      this.renderCellLines(cell, columns - 4)
    );

    if (snapshot.activeCell && snapshot.activeCell.text.trim().length > 0) {
      rendered.push(...this.renderCellLines({
        id: 0,
        kind: snapshot.activeCell.kind,
        text: snapshot.activeCell.text
      }, columns - 4));
    }

    if (rendered.length === 0) {
      rendered.push(
        this.theme.muted(
          this.fitLine(
            "No messages yet. Start with a word, a question, /review, or /rescue.",
            Math.max(12, columns - 6)
          )
        )
      );
    }

    const innerHeight = Math.max(1, height - 2);
    const tail = rendered.slice(Math.max(0, rendered.length - innerHeight));
    const padding = Array.from(
      { length: Math.max(0, innerHeight - tail.length) },
      () => ""
    );

    return this.renderPanel(
      columns,
      "Transcript",
      [...padding, ...tail]
    );
  }

  private renderCellLines(entry: ShellTranscriptCell, columns: number): string[] {
    const maxWidth = Math.max(12, columns - 2);
    const sourceLines = entry.text.split("\n");
    const output: string[] = [];

    sourceLines.forEach((sourceLine, sourceIndex) => {
      const wrappedLines = wrapDisplayText(sourceLine, maxWidth);

      wrappedLines.forEach((line, wrappedIndex) => {
        switch (entry.kind) {
          case "companion-card":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? this.theme.heading(line)
                : line
            );
            break;
          case "companion-line":
            output.push(this.theme.companionLine(line));
            break;
          case "assistant":
            output.push(line);
            break;
          case "help":
            output.push(this.theme.muted(line));
            break;
          case "data":
            output.push(
              entry.study
                ? this.renderStudyLine(entry.study, line, sourceIndex, wrappedIndex)
                : line
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

    const elapsed = this.waitingSince === null
      ? ""
      : `  ${((Date.now() - this.waitingSince) / 1000).toFixed(1)}s`;

    return this.theme.status(
      this.fitLine(
        `Status  ${WAITING_FRAMES[this.waitingFrame] ?? "•"} ${this.waitingLabel ?? "PawMemo"}  ${this.waitingText}${elapsed}`,
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
        return isFirstLine ? this.theme.heading(line) : this.theme.muted(line);
      case "review-card":
        if (isFirstLine) {
          return this.theme.status(line);
        }

        if (study.emphasis && line.includes(study.emphasis)) {
          return this.theme.prompt(line);
        }

        return line;
      case "review-summary":
        return isFirstLine ? this.theme.heading(line) : line;
      default:
        return line;
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
    const composerWidth = Math.max(12, columns - 6);
    const composerLine = this.renderComposerInput(composerWidth);
    return this.renderPanel(columns, "Composer", [
      this.theme.muted(
        this.fitLine(
          "Enter to send. /quit to leave. Arrows move, Backspace/Delete edit, Home/End jump.",
          composerWidth
        )
      ),
      composerLine
    ]);
  }

  private renderHeader(columns: number): string[] {
    const innerWidth = Math.max(12, columns - 6);
    const cwd = process.cwd().replace(process.env.HOME ?? "", "~");

    return this.renderPanel(columns, undefined, [
      this.theme.heading(`PawMemo Shell (${this.displayName})`),
      this.theme.muted(
        this.fitLine("conversation-first companion  experimental TUI preview", innerWidth)
      ),
      this.fitLine(`directory: ${cwd}`, innerWidth),
      this.fitLine("surface: transcript + status + composer", innerWidth)
    ]);
  }

  private renderTip(columns: number): string[] {
    return [
      this.fitLine(
        "Tip: start with natural chat, /review for a lap, or /rescue to pull one important word back first.",
        columns
      )
    ];
  }

  private renderFooter(columns: number): string[] {
    const cwd = process.cwd().replace(process.env.HOME ?? "", "~");
    return [
      this.theme.muted(
        this.fitLine(
          `${this.displayName}  ·  ${this.transcript.snapshot().committedCells.length} cells  ·  ${this.composerBuffer.length} chars  ·  ${cwd}`,
          columns
        )
      )
    ];
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

  private renderPanel(
    columns: number,
    title: string | undefined,
    contentLines: string[]
  ): string[] {
    const innerWidth = Math.max(12, columns - 4);
    const topBorderBase = title
      ? `┌─ ${title} ${"─".repeat(Math.max(0, innerWidth - visibleDisplayWidth(title) - 3))}┐`
      : `┌${"─".repeat(innerWidth + 2)}┐`;
    const topBorder = this.theme.muted(topBorderBase);
    const bottomBorder = this.theme.muted(`└${"─".repeat(innerWidth + 2)}┘`);

    const body = contentLines.map((line) => {
      const padding = Math.max(0, innerWidth - visibleDisplayWidth(line));
      return `${this.theme.muted("│")} ${line}${" ".repeat(padding)} ${this.theme.muted("│")}`;
    });

    return [topBorder, ...body, bottomBorder];
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
