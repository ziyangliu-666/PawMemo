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
const DEFAULT_SHELL_PROMPT = "› ";
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

  private _readline: ReturnType<typeof createInterface> | undefined;

  private get readline() {
    if (!this._readline) {
      this._readline = createInterface({
        input,
        output,
        terminal: Boolean(input.isTTY && output.isTTY)
      });
    }
    return this._readline;
  }

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
    this._readline?.close();
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
  setMode?(mode: string, dueCount?: number): void;
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
    this.terminal.write(this.theme.heading(`${displayName} · Chat`));
  }

  setMode(mode: string, dueCount?: number): void {
    void mode;
    void dueCount;
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
      setMode: (mode: string) => this.setMode(mode),
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

const KNOWN_COMMANDS = [
  { name: "/review", description: "review your due cards" },
  { name: "/rescue", description: "rescue an overdue card" },
  { name: "/stats", description: "view your study statistics" },
  { name: "/capture", description: "capture a new word" },
  { name: "/ask", description: "ask a question about a concept" },
  { name: "/model", description: "choose what model and reasoning effort to use" },
  { name: "/pet", description: "interact with your companion" },
  { name: "/help", description: "show general help commands" },
  { name: "/quit", description: "leave the shell" }
];

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
  private activeCompanionLine: string | null = null;
  private displayName = "PawMemo";
  private active = false;
  private shellMode = "Chat";
  private dueCount = 0;
  private slashSuggestions: string[] = [];
  private suggestionIndex = 0;
  private promptResolver: ((input: string) => void) | null = null;
  private inputBuffer = "";
  private blinkState = true;
  private blinkTimer: NodeJS.Timeout | null = null;

  setMode(mode: string, dueCount?: number): void {
    this.shellMode = mode;
    if (dueCount !== undefined) {
      this.dueCount = dueCount;
    }
    this.renderFrame();
  }

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
    if (this.canUseInlineComposer()) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", this.onGlobalData);
    }
    this.renderFrame();
    this.blinkTimer = setInterval(() => {
      this.blinkState = !this.blinkState;
      this.renderFrame();
    }, 500);
  }

  private readonly onGlobalData = (chunk: Buffer | string): void => {
    this.inputBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    // Continuously extract complete tokens from the inputBuffer
    while (this.inputBuffer.length > 0) {
      // 1. Check for complete or partial escape sequences
      if (this.inputBuffer.startsWith("\u001b")) {
        // Known complete sequences
        if (this.inputBuffer.startsWith("\u001b[3~")) {
          this.deleteAfterCursor();
          this.inputBuffer = this.inputBuffer.slice(4);
          continue;
        }

        // eslint-disable-next-line no-control-regex
        const mouseMatch = this.inputBuffer.match(/^\u001b\[<([0-9;]+)[mM]/);
        if (mouseMatch) {
          const fullMatch = mouseMatch[0];
          if (fullMatch.startsWith("\u001b[<64;")) {
            this.scrollTranscriptUp();
          } else if (fullMatch.startsWith("\u001b[<65;")) {
            this.scrollTranscriptDown();
          }
          // Ignore other mouse clicks or drags
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          continue;
        }

        // eslint-disable-next-line no-control-regex
        const csiMatch = this.inputBuffer.match(/^\u001b\[[0-9;]*[a-zA-Z]/);
        if (csiMatch) {
          const fullMatch = csiMatch[0];
          switch (fullMatch) {
            case "\u001b[D": this.moveCursorLeft(); break;
            case "\u001b[C": this.moveCursorRight(); break;
            case "\u001b[H": this.moveCursorHome(); break;
            case "\u001b[F": this.moveCursorEnd(); break;
            case "\u001b[5~": this.scrollTranscriptUp(10); break;
            case "\u001b[6~": this.scrollTranscriptDown(10); break;
            case "\u001b[A":
              if (this.slashSuggestions.length > 0) {
                this.suggestionIndex = (this.suggestionIndex - 1 + this.slashSuggestions.length) % this.slashSuggestions.length;
                this.renderFrame();
              } else {
                this.scrollTranscriptUp(1);
              }
              break;
            case "\u001b[B":
              if (this.slashSuggestions.length > 0) {
                this.suggestionIndex = (this.suggestionIndex + 1) % this.slashSuggestions.length;
                this.renderFrame();
              } else {
                this.scrollTranscriptDown(1);
              }
              break;
          }
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          continue;
        }

        // eslint-disable-next-line no-control-regex
        const ss3Match = this.inputBuffer.match(/^\u001bO[a-zA-Z]/);
        if (ss3Match) {
          const fullMatch = ss3Match[0];
          switch (fullMatch) {
            case "\u001bOH": this.moveCursorHome(); break;
            case "\u001bOF": this.moveCursorEnd(); break;
          }
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          continue;
        }

        // If it starts with ESC but doesn't match a complete sequence,
        // we must wait for more data to arrive in the next chunk.
        // If the buffer is getting too long (e.g. garbage), flush it.
        if (this.inputBuffer.length < 16) {
          break;
        } else {
          this.inputBuffer = this.inputBuffer.slice(1);
          continue;
        }
      }

      // 2. Process regular characters
      const token = this.inputBuffer[0];
      this.inputBuffer = this.inputBuffer.slice(1);

      switch (token) {
        case "\r":
        case "\n": {
          if (!this.promptResolver) {
            break;
          }

          if (this.slashSuggestions.length > 0) {
            this.composerBuffer = this.slashSuggestions[this.suggestionIndex] + " ";
            this.composerCursor = this.composerBuffer.length;
            this.updateAutocompleteState();
            this.renderFrame();
            break;
          }

          const submitted = this.composerBuffer;
          if (submitted.trim().length === 0) {
            break;
          }

          const resolver = this.promptResolver;
          this.promptResolver = null;
          this.composerBuffer = "";
          this.composerCursor = 0;
          this.suggestionIndex = 0;
          this.slashSuggestions = [];

          this.appendEntry({ kind: "user-line", text: submitted });
          resolver(submitted);
          return;
        }
        case "\t": {
          if (this.slashSuggestions.length > 0) {
            this.composerBuffer = this.slashSuggestions[this.suggestionIndex] + " ";
            this.composerCursor = this.composerBuffer.length;
            this.updateAutocompleteState();
            this.renderFrame();
          }
          break;
        }
        case "\u0003": { // Ctrl+C
          if (this.promptResolver) {
            const resolver = this.promptResolver;
            this.promptResolver = null;
            this.composerBuffer = "/quit";
            this.composerCursor = 0;
            this.suggestionIndex = 0;
            this.slashSuggestions = [];
            this.transcriptScrollOffset = 0;
            this.renderFrame();
            resolver("/quit");
          } else {
            // Global Ctrl+C handler outside of prompt
            void this.close();
            process.exit(0);
          }
          return;
        }
        case "\u0004": { // Ctrl+D
          if (!this.promptResolver && !this.composerBuffer) {
              void this.close();
              process.exit(0);
          }
          break;
        }
        case "\u007f":
        case "\b": {
          this.deleteBeforeCursor();
          break;
        }
        case "\u001b": {
          if (this.slashSuggestions.length > 0) {
            this.slashSuggestions = [];
            this.suggestionIndex = 0;
            this.renderFrame();
          } else {
            this.composerBuffer = "";
            this.composerCursor = 0;
            this.renderFrame();
          }
          break;
        }
        default: {
          this.insertAtCursor(token);
        }
      }
    }
  };

  prompt(): Promise<string> {
    return this.promptWithLabel(DEFAULT_SHELL_PROMPT);
  }

  renderCompanionCard(text: string): void {
    this.appendEntry({ kind: "companion-card", text });
  }

  renderCompanionLine(text: string): void {
    this.activeCompanionLine = text;
    this.renderFrame();
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
      setMode: (mode: string) => this.setMode(mode),
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
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.active) {
      if (this.canUseInlineComposer()) {
        process.stdin.off("data", this.onGlobalData);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      }
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
    return await new Promise<string>((resolve) => {
      this.promptResolver = resolve;
    });
  }

  private insertAtCursor(text: string): void {
    if (text.length === 0) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor)}${text}${this.composerBuffer.slice(this.composerCursor)}`;
    this.composerCursor += text.length;
    this.updateAutocompleteState();
    this.transcriptScrollOffset = 0;
    this.resetBlink();
    this.renderFrame();
  }

  private resetBlink(): void {
    this.blinkState = true;
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = setInterval(() => {
        this.blinkState = !this.blinkState;
        this.renderFrame();
      }, 500);
    }
  }

  private deleteBeforeCursor(): void {
    if (this.composerCursor <= 0) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor - 1)}${this.composerBuffer.slice(this.composerCursor)}`;
    this.composerCursor -= 1;
    this.updateAutocompleteState();
    this.resetBlink();
    this.renderFrame();
  }

  private deleteAfterCursor(): void {
    if (this.composerCursor >= this.composerBuffer.length) {
      return;
    }

    this.composerBuffer = `${this.composerBuffer.slice(0, this.composerCursor)}${this.composerBuffer.slice(this.composerCursor + 1)}`;
    this.updateAutocompleteState();
    this.resetBlink();
    this.renderFrame();
  }

  private updateAutocompleteState(): void {
    const buffer = this.composerBuffer;
    if (buffer.startsWith("/") && buffer.length > 0) {
      const matchPrefix = buffer.toLowerCase();
      this.slashSuggestions = KNOWN_COMMANDS.filter(cmd => cmd.name.startsWith(matchPrefix)).map(c => c.name);
      this.suggestionIndex = 0;
    } else {
      this.slashSuggestions = [];
      this.suggestionIndex = 0;
    }
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
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorRight(): void {
    if (this.composerCursor >= this.composerBuffer.length) {
      return;
    }

    this.composerCursor += 1;
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorHome(): void {
    this.composerCursor = 0;
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorEnd(): void {
    this.composerCursor = this.composerBuffer.length;
    this.resetBlink();
    this.renderFrame();
  }

  private renderFrame(): void {
    if (!this.terminal.writeRaw || !this.active) {
      return;
    }

    const columns = process.stdout.columns ?? DEFAULT_TUI_COLUMNS;
    const rows = process.stdout.rows ?? DEFAULT_TUI_ROWS;
    const headerLines = this.renderHeader(columns);
    const tipLines = this.renderTip();
    const statusLines = this.renderStatusLine(columns);
    const composerLines = this.renderComposer(columns);
    const footerLines = this.renderFooter(columns);
    const separatorLine = this.theme.muted("─".repeat(columns));
    const occupiedHeight =
      headerLines.length +
      1 + // Top separator
      tipLines.length +
      1 + // Above interactive separator
      statusLines.length +
      composerLines.length +
      (footerLines.length > 0 ? 1 : 0) + // Below interactive separator
      footerLines.length;
    const transcriptHeight = Math.max(
      4,
      rows - occupiedHeight
    );

    const transcriptLines = this.renderTranscript(columns, transcriptHeight);

    const frame = [
      ...headerLines,
      separatorLine,
      ...tipLines,
      ...transcriptLines,
      separatorLine,
      ...statusLines,
      ...composerLines,
      ...(footerLines.length > 0 ? [separatorLine] : []),
      ...footerLines
    ]
      .slice(0, rows)
      .join("\n");

    this.terminal.writeRaw(`${ANSI_CLEAR_SCREEN}${frame}`);
  }

  private renderTranscript(columns: number, height: number): string[] {
    const snapshot = this.transcript.snapshot();

    let rendered: string[] = [];

    if (this.shellMode === "Review" || this.shellMode === "Reveal" || this.shellMode === "Summary") {
      rendered = this.renderTranscriptWithReviewPanel(snapshot.committedCells, columns);
    } else {
      rendered = snapshot.committedCells.flatMap((cell, i) => {
        const lines = this.renderCellLines(cell, columns);
        const prevCell = snapshot.committedCells[i - 1];
        const isConsecutiveStudy = i > 0 && cell.study && prevCell?.study;
        return (i > 0 && !isConsecutiveStudy) ? ["", ...lines] : lines;
      });

      if (snapshot.activeCell && snapshot.activeCell.text.trim().length > 0) {
        if (rendered.length > 0) {
           rendered.push("");
        }
        rendered.push(...this.renderCellLines({
          id: 0,
          kind: snapshot.activeCell.kind,
          text: snapshot.activeCell.text
        }, columns));
      }
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

    // Add a trailing blank line to ensure transcript content never touches the composer directly
    rendered.push("");

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

    return [...padding, ...tail];
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
                ? this.theme.heading(line)
                : line
            );
            break;
          case "companion-line":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? this.theme.companionLine(line)
                : this.theme.companionLine(line)
            );
            break;
          case "assistant":
            output.push(
              sourceIndex === 0 && wrappedIndex === 0
                ? `• ${line}`
                : `  ${line}`
            );
            break;
          case "user-line": {
            const prefix = sourceIndex === 0 && wrappedIndex === 0 ? "› " : "  ";
            const visibleW = visibleDisplayWidth(`${prefix}${line}`);
            const padR = Math.max(0, columns - visibleW);
            output.push(this.theme.userLineBg(`${prefix}${line}${" ".repeat(padR)}`));
            break;
          }
          case "help":
            output.push(this.theme.muted(line));
            break;
          case "data": {
            const styled = entry.study 
              ? this.renderStudyLine(entry.study, line, sourceIndex, wrappedIndex) 
              : line;
            
            if (entry.study?.kind === "review-card") {
               const padW = Math.max(0, columns - visibleDisplayWidth(styled) - 4);
               output.push(this.theme.reviewCardBg(`  ${styled}${" ".repeat(padW)}  `));
            } else {
               output.push(styled);
            }
            break;
          }
        }
      });
    });

    return output;
  }

  private renderTranscriptWithReviewPanel(cells: ShellTranscriptCell[], columns: number): string[] {
    let startIndex = 0;
    for (let i = cells.length - 1; i >= 0; i--) {
      const cell = cells[i] as ShellTranscriptCell;
      if (cell.kind === "user-line" || cell.dataKind === "review-card-heading" || cell.study?.kind === "review-intro" || cell.study?.kind === "rescue-intro") {
        startIndex = i;
        if (cell.kind === "user-line") {
          startIndex += 1;
        }
        break;
      }
    }

    const priorCells = cells.slice(0, startIndex);
    const renderedPrior = priorCells.flatMap((cell, i) => {
      const lines = this.renderCellLines(cell, columns);
      return i > 0 ? ["", ...lines] : lines;
    });

    if (startIndex >= cells.length) {
      return renderedPrior;
    }
    
    const cardCells = cells.slice(startIndex);
    const cardWidth = Math.min(64, Math.max(40, columns - 10)); 
    
    const panelLines: string[] = [];
    
    panelLines.push(this.theme.reviewCardBg(" ".repeat(cardWidth)));
    
    for (const cell of cardCells) {
      const lines = this.renderCellLinesForCard(cell, cardWidth - 4); 
      for (const line of lines) {
        const visibleW = visibleDisplayWidth(line);
        const padR = Math.max(0, cardWidth - 4 - visibleW);
        const padded = `  ${line}${" ".repeat(padR + 2)}`;
        panelLines.push(this.theme.reviewCardBg(padded));
      }
    }
    
    panelLines.push(this.theme.reviewCardBg(" ".repeat(cardWidth)));
    
    const leftPadding = Math.max(0, Math.floor((columns - cardWidth) / 2));
    const centeredPanel = panelLines.map(line => `${" ".repeat(leftPadding)}${line}`);
    
    return [
      ...renderedPrior,
      ...(renderedPrior.length > 0 ? [""] : []),
      ...centeredPanel,
      ""
    ];
  }

  private renderCellLinesForCard(entry: ShellTranscriptCell, maxWidth: number): string[] {
    const sourceLines = entry.text.split("\n");
    const output: string[] = [];

    sourceLines.forEach((sourceLine, sourceIndex) => {
      const wrappedLines = wrapDisplayText(sourceLine, maxWidth);

      wrappedLines.forEach((line, wrappedIndex) => {
         const isFirstLine = sourceIndex === 0 && wrappedIndex === 0;
         if (entry.kind === "data") {
            if (entry.study) {
               switch (entry.study.kind) {
                 case "review-intro":
                 case "rescue-intro":
                    output.push(isFirstLine ? this.theme.heading(line) : this.theme.muted(line));
                    break;
                 case "review-card":
                    if (isFirstLine) {
                      output.push(this.theme.status(line));
                    } else if (entry.study.emphasis && line.includes(entry.study.emphasis)) {
                      output.push(this.theme.prompt(line));
                    } else {
                      output.push(line);
                    }
                    break;
                 case "review-summary":
                    output.push(isFirstLine ? this.theme.heading(line) : line);
                    break;
                 default:
                    output.push(line);
                    break;
               }
            } else {
               output.push(line);
            }
         } else {
            output.push(line);
         }
      });
    });

    return output;
  }

  private renderStatusLine(columns: number): string[] {
    if (this.waitingText === null) {
      return [];
    }

    return [
      this.theme.status(
        this.fitLine(
          `${WAITING_FRAMES[this.waitingFrame] ?? "•"} ${this.waitingLabel ?? "PawMemo"}  ${this.waitingText}`,
          columns
        )
      )
    ];
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
          ? this.theme.heading(line)
          : this.theme.muted(line);
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
    const lines: string[] = [];

    if (this.slashSuggestions.length > 0) {
       this.slashSuggestions.forEach((cmd, i) => {
         const info = KNOWN_COMMANDS.find(k => k.name === cmd);
         const desc = info ? info.description : "";
         const isSelected = i === this.suggestionIndex;
         
         const namePart = cmd.padEnd(16);
         let safeDesc = desc;
         const availableWidth = columns - 18;
         if (availableWidth < 5) {
             safeDesc = "";
         } else if (stringDisplayWidth(safeDesc) > availableWidth) {
             safeDesc = safeDesc.slice(0, availableWidth - 2) + "…";
         }
         
         const nameStyled = this.theme.prompt(namePart);
         const descStyled = this.theme.muted(safeDesc);
         
         if (isSelected) {
            lines.push(`\u001b[48;5;236m${nameStyled} ${descStyled}\u001b[0m`);
         } else {
            lines.push(`${nameStyled} ${descStyled}`);
         }
       });
    } else {
       // Silent when no suggestions
    }

    const composerLine = this.renderComposerInput(columns);
    const visibleW = visibleDisplayWidth(composerLine);
    
    const padR = Math.max(0, columns - visibleW);
    const padded = `${composerLine}${" ".repeat(padR)}`;
    
    lines.push(padded);
    return lines;
  }

  private renderHeader(columns: number): string[] {
    const headerText = this.dueCount > 0 
      ? `${this.displayName} · ${this.shellMode} · ${this.dueCount} due`
      : `${this.displayName} · ${this.shellMode}`;

    return [
      this.theme.heading(this.fitLine(headerText, columns))
    ];
  }

  private renderTip(): string[] {
    return [];
  }

  private renderFooter(columns: number): string[] {
    if (!this.activeCompanionLine) {
        return [];
    }
    // Use columns-1 for the bottom-most line of the screen to prevent terminal from
    // auto-scrolling when writing to the last cell.
    return [
        this.theme.companionLine(this.fitLine(this.activeCompanionLine, columns - 1))
    ];
  }

  private renderComposerInput(columns: number): string {
    const prompt = `${this.activePromptLabel}`;
    const cursor = Math.max(0, Math.min(this.composerCursor, this.composerBuffer.length));
    const cursorChar = this.blinkState ? CURSOR_GLYPH : " ";
    const rawContent =
      `${this.composerBuffer.slice(0, cursor)}${cursorChar}${this.composerBuffer.slice(cursor)}`;
    // Keep it explicitly shorter by 1 to prevent terminal auto-wrap from scrolling the screen
    const maxContentWidth = Math.max(1, columns - visibleDisplayWidth(prompt) - 1);
    const visibleContent = this.tailDisplayText(rawContent, maxContentWidth);
    return `${this.theme.heading(prompt)}${visibleContent}`;
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
