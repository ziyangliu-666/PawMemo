import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { StringDecoder } from "node:string_decoder";

import type { CliDataKind } from "./theme";
import { createCliTheme, shouldUseColor } from "./theme";
import {
  formatPromptSelectionPrompt,
  resolvePromptSelection,
  type PromptSelectionRequest,
  type ReviewSessionTerminal
} from "./review-session-runner";
import { flattenStudyCardIntent } from "./study-card-view";
import type { StudyCardSection, StudyCellIntent } from "./transcript-intent";
import {
  ShellTranscriptModel,
  type ShellStudyCellPayload,
  type ShellTranscriptCell
} from "./shell-transcript";

const SHELL_STREAM_DELAY_MS = 8;
const SHELL_WAIT_FRAME_MS = 100;
const SHELL_WAIT_HIGHLIGHT_STEP = 4;
const DEFAULT_SHELL_PROMPT = "› ";
const WAITING_FRAMES = ["·", "•", "●", "•"];
const ANSI_CLEAR_LINE = "\r\u001b[2K";
const ANSI_CLEAR_SCREEN = "\u001b[2J\u001b[H";
const ANSI_HOME = "\u001b[H";
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
const MAX_VISIBLE_SELECTION_CHOICES = 8;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const SHELL_EXIT_CONFIRM_HINT = "Press Ctrl+C again to exit. Any other action cancels.";

type ComposerInputEvent =
  | { kind: "submit" }
  | { kind: "tab" }
  | { kind: "interrupt" }
  | { kind: "eof" }
  | { kind: "backspace" }
  | { kind: "escape" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "page-up" }
  | { kind: "page-down" }
  | { kind: "shift-tab" }
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string };

type ComposerRenderResult = {
  line: string;
  cursorColumn: number;
};

type ShellSurfaceEntryInput = {
  kind: ShellTranscriptCell["kind"];
  text: string;
  dataKind?: CliDataKind;
  study?: ShellStudyCellPayload;
};

interface ActiveSelectionPrompt {
  request: PromptSelectionRequest;
  selectedIndex: number;
  resolve: (input: string) => void;
}

interface TuiShellSurfaceOptions {
  debug?: boolean;
}

export interface ShellStreamHighlightConfig {
  percent: number;
  totalChars: number;
}

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
  beginAssistantReplyStream(): void;
  appendAssistantReplyDelta(delta: string): void;
  finishAssistantReplyStream(commit: boolean): void;
  writeAssistantReply(text: string, signal?: AbortSignal): Promise<void>;
  writeAssistantReplyNow(text: string): void;
  writeAlert(text: string): void;
  showInterruptHint?(text: string): void;
  clearInterruptHint?(): void;
  writeHelp(text: string): void;
  writeDataBlock(
    text: string,
    kind?: CliDataKind,
    study?: StudyCellIntent
  ): void;
  createReviewSessionTerminal(): ReviewSessionTerminal;
  setMode?(mode: string, dueCount?: number): void;
  setStreamHighlight?(config: ShellStreamHighlightConfig | null): void;
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

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme"
});

function splitGraphemes(text: string): string[] {
  return Array.from(
    graphemeSegmenter.segment(text),
    (entry) => entry.segment
  );
}

function firstGrapheme(text: string): string {
  return splitGraphemes(text)[0] ?? "";
}

function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];

  for (const entry of graphemeSegmenter.segment(text)) {
    const end = entry.index + entry.segment.length;
    if (end > boundaries[boundaries.length - 1]) {
      boundaries.push(end);
    }
  }

  if (boundaries[boundaries.length - 1] !== text.length) {
    boundaries.push(text.length);
  }

  return boundaries;
}

function clampToNearestGraphemeBoundary(text: string, cursor: number): number {
  const target = Math.max(0, Math.min(cursor, text.length));
  const boundaries = graphemeBoundaries(text);
  let best = boundaries[0] ?? 0;
  let bestDistance = Math.abs(best - target);

  for (const boundary of boundaries) {
    const distance = Math.abs(boundary - target);
    if (distance < bestDistance) {
      best = boundary;
      bestDistance = distance;
    }
  }

  return best;
}

function previousGraphemeBoundary(text: string, cursor: number): number {
  const target = clampToNearestGraphemeBoundary(text, cursor);
  const boundaries = graphemeBoundaries(text);

  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary !== undefined && boundary < target) {
      return boundary;
    }
  }

  return 0;
}

function nextGraphemeBoundary(text: string, cursor: number): number {
  const target = clampToNearestGraphemeBoundary(text, cursor);
  const boundaries = graphemeBoundaries(text);

  for (const boundary of boundaries) {
    if (boundary > target) {
      return boundary;
    }
  }

  return text.length;
}

function takeLeadingInputToken(buffer: string): string {
  if (buffer.length === 0) {
    return "";
  }

  const codePoint = buffer.codePointAt(0) ?? 0;
  if (codePoint < 0x20 || codePoint === 0x7f) {
    return String.fromCodePoint(codePoint);
  }

  return firstGrapheme(buffer);
}

function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function composerDisplayText(text: string): string {
  return text.replace(/\t/g, "  ").replace(/\n/g, "⏎");
}

function formatCursorPosition(row: number, column: number): string {
  return `\u001b[${row + 1};${column + 1}H`;
}

function fitComposerViewport(
  before: string,
  after: string,
  maxWidth: number
): {
  before: string;
  after: string;
} {
  const beforeParts = splitGraphemes(before);
  const afterParts = splitGraphemes(after);
  let trimmedStart = false;
  let trimmedEnd = false;

  const currentWidth = () =>
    stringDisplayWidth(beforeParts.join("")) +
    stringDisplayWidth(afterParts.join("")) +
    (trimmedStart ? 1 : 0) +
    (trimmedEnd ? 1 : 0);

  while (currentWidth() > maxWidth) {
    if (beforeParts.length > 0) {
      beforeParts.shift();
      trimmedStart = true;
      continue;
    }

    if (afterParts.length > 0) {
      afterParts.pop();
      trimmedEnd = true;
      continue;
    }

    break;
  }

  return {
    before: `${trimmedStart ? "…" : ""}${beforeParts.join("")}`,
    after: `${afterParts.join("")}${trimmedEnd ? "…" : ""}`
  };
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
    for (const char of splitGraphemes(word)) {
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

function wrapDisplayTextWithPrefixes(
  text: string,
  firstLineWidth: number,
  continuationWidth: number
): string[] {
  const normalized = text.replace(/\t/g, "  ");

  if (firstLineWidth <= 0 || continuationWidth <= 0) {
    return [normalized];
  }

  if (normalized.trim().length === 0) {
    return [""];
  }

  const lines: string[] = [];

  const cutFittingPrefix = (value: string, maxWidth: number): string => {
    let chunk = "";

    for (const char of splitGraphemes(value)) {
      const candidate = `${chunk}${char}`;
      if (stringDisplayWidth(candidate) > maxWidth) {
        break;
      }
      chunk = candidate;
    }

    return chunk;
  };

  const wrapLogicalLine = (
    sourceLine: string,
    startingWidth: number
  ): string[] => {
    if (sourceLine.length === 0) {
      return [""];
    }

    const output: string[] = [];
    const tokens = sourceLine.match(/\S+|\s+/g) ?? [sourceLine];
    let current = "";
    let currentWidth = startingWidth;

    for (const token of tokens) {
      if (/^\s+$/.test(token)) {
        if (current.length === 0) {
          continue;
        }

        const candidate = `${current}${token}`;
        if (stringDisplayWidth(candidate) <= currentWidth) {
          current = candidate;
          continue;
        }

        output.push(current.trimEnd());
        current = "";
        currentWidth = continuationWidth;
        continue;
      }

      let remaining = token;

      while (remaining.length > 0) {
        const candidate = `${current}${remaining}`;
        if (stringDisplayWidth(candidate) <= currentWidth) {
          current = candidate;
          remaining = "";
          continue;
        }

        if (current.length > 0) {
          output.push(current.trimEnd());
          current = "";
          currentWidth = continuationWidth;
          continue;
        }

        const chunk = cutFittingPrefix(remaining, currentWidth);
        if (chunk.length === 0) {
          break;
        }
        output.push(chunk);
        remaining = remaining.slice(chunk.length);
        currentWidth = continuationWidth;
      }
    }

    if (current.length > 0) {
      output.push(current.trimEnd());
    }

    return output.length > 0 ? output : [""];
  };

  let currentWidth = firstLineWidth;

  normalized.split("\n").forEach((sourceLine) => {
    const wrapped = wrapLogicalLine(sourceLine, currentWidth);
    lines.push(...wrapped);
    currentWidth = continuationWidth;
  });

  return lines.length > 0 ? lines : [normalized];
}

function resolveHighlightLength(
  textLength: number,
  config?: ShellStreamHighlightConfig | null
): number {
  if (textLength <= 0) {
    return 0;
  }

  if (!config) {
    return Math.min(
      6,
      Math.max(2, Math.floor(textLength / 4))
    );
  }

  const configuredLength = Math.round((config.totalChars * config.percent) / 100);
  return Math.min(
    textLength,
    Math.max(1, configuredLength)
  );
}

function splitSweepingHighlight(
  text: string,
  tick: number,
  config?: ShellStreamHighlightConfig | null
): {
  before: string;
  active: string;
  after: string;
} {
  const chars = splitGraphemes(text);

  if (chars.length === 0) {
    return {
      before: "",
      active: "",
      after: ""
    };
  }

  const highlightLength = resolveHighlightLength(chars.length, config);
  const maxStart = Math.max(0, chars.length - highlightLength);
  const start = maxStart === 0 ? 0 : tick % (maxStart + 1);
  const end = Math.min(chars.length, start + highlightLength);

  return {
    before: chars.slice(0, start).join(""),
    active: chars.slice(start, end).join(""),
    after: chars.slice(end).join("")
  };
}

export class LineShellSurface implements ShellSurface {
  readonly supportsColor?: boolean;

  private readonly theme: ReturnType<typeof createCliTheme>;
  private streamHighlight: ShellStreamHighlightConfig | null = null;
  private waitingFrame = 0;
  private waitingHighlightStep = 0;
  private waitingText: string | null = null;
  private waitingLabel: string | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private streamedAssistantBuffer = "";
  private streamedAssistantActive = false;
  private streamedAssistantPrefixWritten = false;

  constructor(private readonly terminal: ShellTerminal) {
    this.supportsColor = terminal.supportsColor;
    this.theme = createCliTheme({
      enabled: terminal.supportsColor ?? false
    });
  }

  beginShell(displayName: string): void {
    this.terminal.write(this.theme.heading(`${displayName} · Chat`));
  }

  setStreamHighlight(config: ShellStreamHighlightConfig | null): void {
    this.streamHighlight = config;
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
    this.waitingHighlightStep = 0;

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
      this.waitingHighlightStep += SHELL_WAIT_HIGHLIGHT_STEP;
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
    this.waitingHighlightStep = 0;
  }

  beginAssistantReplyStream(): void {
    this.clearWaitingIndicator();
    this.streamedAssistantBuffer = "";
    this.streamedAssistantActive = true;
    this.streamedAssistantPrefixWritten = false;
  }

  appendAssistantReplyDelta(delta: string): void {
    if (!this.streamedAssistantActive) {
      this.beginAssistantReplyStream();
    }

    if (delta.length === 0) {
      return;
    }

    this.streamedAssistantBuffer += delta;

    if (this.terminal.writeRaw) {
      if (!this.streamedAssistantPrefixWritten) {
        this.terminal.writeRaw(this.formatAssistantPrefix());
        this.streamedAssistantPrefixWritten = true;
      }
      this.terminal.writeRaw(this.theme.assistantLine(delta));
    }
  }

  finishAssistantReplyStream(commit: boolean): void {
    if (!this.streamedAssistantActive) {
      return;
    }

    if (commit) {
      if (this.terminal.writeRaw) {
        if (this.streamedAssistantPrefixWritten) {
          this.terminal.writeRaw("\n");
        }
      } else if (this.streamedAssistantBuffer.trim().length > 0) {
        this.terminal.write(this.formatAssistantReply(this.streamedAssistantBuffer.trim()));
      }
    } else if (this.terminal.writeRaw && this.streamedAssistantPrefixWritten) {
      this.terminal.writeRaw("\n");
    }

    this.streamedAssistantBuffer = "";
    this.streamedAssistantActive = false;
    this.streamedAssistantPrefixWritten = false;
  }

  async writeAssistantReply(text: string, signal?: AbortSignal): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.clearWaitingIndicator();

    if (!this.terminal.writeRaw) {
      this.writeAssistantReplyNow(trimmed);
      return;
    }

    this.beginAssistantReplyStream();
    try {
      const tokens = /\s/.test(trimmed)
        ? trimmed.match(/\S+\s*/g) ?? [trimmed]
        : [...trimmed];

      for (const token of tokens) {
        throwIfAborted(signal);
        this.appendAssistantReplyDelta(token);
        await new Promise((resolve) => setTimeout(resolve, SHELL_STREAM_DELAY_MS));
      }

      throwIfAborted(signal);
      this.finishAssistantReplyStream(true);
    } catch (error) {
      this.finishAssistantReplyStream(false);
      throw error;
    }
  }

  writeAssistantReplyNow(text: string): void {
    this.clearWaitingIndicator();
    this.terminal.write(this.formatAssistantReply(text));
  }

  writeAlert(text: string): void {
    this.clearWaitingIndicator();
    this.terminal.write(this.theme.error(text));
  }

  showInterruptHint(): void {}

  clearInterruptHint(): void {}

  writeHelp(text: string): void {
    this.clearWaitingIndicator();
    this.terminal.write(this.theme.help(text));
  }

  writeDataBlock(
    text: string,
    kind: CliDataKind = "plain",
    study?: StudyCellIntent
  ): void {
    this.clearWaitingIndicator();
    const rendered =
      study?.view?.sections && study.view.sections.length > 0
        ? flattenStudyCardIntent(study)
        : text;
    this.terminal.write(this.theme.dataBlock(rendered, study ? "plain" : kind));
  }

  private formatAssistantPrefix(): string {
    if (!this.theme.enabled) {
      return "";
    }

    return this.theme.assistantLine("• ");
  }

  private formatAssistantReply(text: string): string {
    if (!this.theme.enabled) {
      return text;
    }

    return `${this.formatAssistantPrefix()}${this.theme.assistantLine(text)}`;
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
      select: (request: PromptSelectionRequest) =>
        this.terminal.prompt(this.theme.prompt(formatPromptSelectionPrompt(request))),
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
    const waitingText = this.waitingText ?? "";
    const { before, active, after } = splitSweepingHighlight(
      waitingText,
      this.waitingHighlightStep,
      this.streamHighlight
    );

    return [
      this.theme.status(`${frame}${label}  ${before}`),
      this.theme.statusAccent(active),
      this.theme.status(after)
    ].join("");
  }
}

const KNOWN_COMMANDS = [
  { name: "/review", description: "review your due cards" },
  { name: "/rescue", description: "rescue an overdue card" },
  { name: "/stats", description: "view your study statistics" },
  { name: "/highlight", description: "tune stream highlight with percent and total chars" },
  { name: "/capture", description: "capture a new word" },
  { name: "/ask", description: "ask a question about a concept" },
  { name: "/models", description: "pick a provider and model from a list" },
  { name: "/model", description: "choose what model and reasoning effort to use" },
  { name: "/pet", description: "interact with your companion" },
  { name: "/help", description: "show general help commands" },
  { name: "/quit", description: "leave the shell" }
];

export class TuiShellSurface implements ShellSurface {
  readonly supportsColor?: boolean;

  private readonly theme: ReturnType<typeof createCliTheme>;
  private readonly transcript = new ShellTranscriptModel();
  private readonly debugEnabled: boolean;
  private streamHighlight: ShellStreamHighlightConfig | null = null;
  private waitingFrame = 0;
  private waitingHighlightStep = 0;
  private waitingLabel: string | null = null;
  private waitingText: string | null = null;
  private waitingSince: number | null = null;
  private waitingTimer: NodeJS.Timeout | null = null;
  private activePromptLabel = DEFAULT_SHELL_PROMPT;
  private interruptHint: string | null = null;
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
  private activeSelectionPrompt: ActiveSelectionPrompt | null = null;
  private readonly inputDecoder = new StringDecoder("utf8");
  private inputBuffer = "";
  private bracketedPasteBuffer: string | null = null;
  private blinkTimer: NodeJS.Timeout | null = null;
  private deferredPromptSubmit = false;
  private exitConfirmPending = false;

  setMode(mode: string, dueCount?: number): void {
    this.shellMode = mode;
    if (dueCount !== undefined) {
      this.dueCount = dueCount;
    }
    this.renderFrame();
  }

  constructor(
    private readonly terminal: ShellTerminal,
    options: TuiShellSurfaceOptions = {}
  ) {
    this.supportsColor = terminal.supportsColor;
    this.debugEnabled = options.debug ?? false;
    this.theme = createCliTheme({
      enabled: terminal.supportsColor ?? false
    });
  }

  setStreamHighlight(config: ShellStreamHighlightConfig | null): void {
    this.streamHighlight = config;
    this.renderFrame();
  }

  showInterruptHint(text: string): void {
    const next = text.trim();
    if (next.length === 0) {
      return;
    }
    this.interruptHint = next;
    this.renderFrame();
  }

  clearInterruptHint(): void {
    if (this.interruptHint === null) {
      return;
    }
    this.interruptHint = null;
    this.renderFrame();
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
      `${ANSI_ALT_SCREEN_ON}${ANSI_MOUSE_TRACKING_ON}${ANSI_CLEAR_SCREEN}`
    );
    if (this.canUseInlineComposer()) {
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on("data", this.onGlobalData);
    }
    this.renderFrame();
  }

  private readonly onGlobalData = (chunk: Buffer | string): void => {
    const decoded =
      typeof chunk === "string" ? chunk : this.inputDecoder.write(chunk);

    if (decoded.length === 0) {
      return;
    }

    this.inputBuffer += decoded;

    while (this.inputBuffer.length > 0) {
      const event = this.parseNextComposerInputEvent();
      if (!event) {
        break;
      }

      if (this.handleComposerInputEvent(event)) {
        return;
      }
    }
  };

  private parseNextComposerInputEvent(): ComposerInputEvent | null {
    while (this.inputBuffer.length > 0) {
      if (this.bracketedPasteBuffer !== null) {
        const endIndex = this.inputBuffer.indexOf(BRACKETED_PASTE_END);
        if (endIndex === -1) {
          this.bracketedPasteBuffer += this.inputBuffer;
          this.inputBuffer = "";
          return null;
        }

        this.bracketedPasteBuffer += this.inputBuffer.slice(0, endIndex);
        this.inputBuffer = this.inputBuffer.slice(
          endIndex + BRACKETED_PASTE_END.length
        );
        const pasted = normalizePastedText(this.bracketedPasteBuffer);
        this.bracketedPasteBuffer = null;
        return { kind: "paste", text: pasted };
      }

      if (this.inputBuffer.startsWith(BRACKETED_PASTE_START)) {
        this.inputBuffer = this.inputBuffer.slice(BRACKETED_PASTE_START.length);
        this.bracketedPasteBuffer = "";
        continue;
      }

      if (this.inputBuffer.startsWith("\u001b")) {
        if (this.inputBuffer.startsWith("\u001b[3~")) {
          this.inputBuffer = this.inputBuffer.slice(4);
          return { kind: "delete" };
        }

        // eslint-disable-next-line no-control-regex
        const mouseMatch = this.inputBuffer.match(/^\u001b\[<([0-9;]+)[mM]/);
        if (mouseMatch) {
          const fullMatch = mouseMatch[0];
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          if (fullMatch.startsWith("\u001b[<64;")) {
            return { kind: "up" };
          }
          if (fullMatch.startsWith("\u001b[<65;")) {
            return { kind: "down" };
          }
          continue;
        }

        // eslint-disable-next-line no-control-regex
        const csiMatch = this.inputBuffer.match(/^\u001b\[[0-9;]*[a-zA-Z]/);
        if (csiMatch) {
          const fullMatch = csiMatch[0];
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          if (new RegExp(`^${ANSI_ESCAPE}\\[13(?:;[0-9:]+)*u$`).test(fullMatch)) {
            return { kind: "submit" };
          }
          switch (fullMatch) {
            case "\u001b[D":
              return { kind: "left" };
            case "\u001b[C":
              return { kind: "right" };
            case "\u001b[H":
              return { kind: "home" };
            case "\u001b[F":
              return { kind: "end" };
            case "\u001b[5~":
              return { kind: "page-up" };
            case "\u001b[6~":
              return { kind: "page-down" };
            case "\u001b[Z":
              return { kind: "shift-tab" };
            case "\u001b[A":
              return { kind: "up" };
            case "\u001b[B":
              return { kind: "down" };
            default:
              this.writeInputDebug("ignored-csi-sequence", {
                sequence: this.previewDebugValue(fullMatch)
              });
              continue;
          }
        }

        // eslint-disable-next-line no-control-regex
        const ss3Match = this.inputBuffer.match(/^\u001bO[a-zA-Z]/);
        if (ss3Match) {
          const fullMatch = ss3Match[0];
          this.inputBuffer = this.inputBuffer.slice(fullMatch.length);
          switch (fullMatch) {
            case "\u001bOH":
              return { kind: "home" };
            case "\u001bOF":
              return { kind: "end" };
            case "\u001bOM":
              return { kind: "submit" };
            default:
              this.writeInputDebug("ignored-ss3-sequence", {
                sequence: this.previewDebugValue(fullMatch)
              });
              continue;
          }
        }

        if (this.inputBuffer.length < 16) {
          return null;
        }

        this.inputBuffer = this.inputBuffer.slice(1);
        return { kind: "escape" };
      }

      const token = takeLeadingInputToken(this.inputBuffer);
      if (token.length === 0) {
        return null;
      }
      this.inputBuffer = this.inputBuffer.slice(token.length);

      if (
        (token === "\r" && this.inputBuffer[0] === "\n") ||
        (token === "\n" && this.inputBuffer[0] === "\r")
      ) {
        this.inputBuffer = this.inputBuffer.slice(1);
      }

      switch (token) {
        case "\r":
        case "\n":
          return { kind: "submit" };
        case "\t":
          return { kind: "tab" };
        case "\u0003":
          return { kind: "interrupt" };
        case "\u0004":
          return { kind: "eof" };
        case "\u007f":
        case "\b":
          return { kind: "backspace" };
        case "\u001b":
          return { kind: "escape" };
        default:
          return { kind: "text", text: token };
      }
    }

    return null;
  }

  private handleComposerInputEvent(event: ComposerInputEvent): boolean {
    if (event.kind !== "interrupt" && this.exitConfirmPending) {
      this.exitConfirmPending = false;
      this.clearInterruptHint();
    }

    switch (event.kind) {
      case "submit": {
        if (this.activeSelectionPrompt) {
          this.submitActiveSelection();
          return true;
        }

        if (!this.promptResolver) {
          if (this.composerBuffer.trim().length > 0) {
            this.deferredPromptSubmit = true;
            this.writeInputDebug("submit-deferred", {
              buffered: this.previewDebugValue(this.composerBuffer),
              length: this.composerBuffer.length
            });
          }
          return false;
        }

        if (this.slashSuggestions.length > 0) {
          this.composerBuffer = `${this.slashSuggestions[this.suggestionIndex] ?? ""} `;
          this.composerCursor = this.composerBuffer.length;
          this.updateAutocompleteState();
          this.renderFrame();
          return false;
        }

        return this.commitPromptSubmission();
      }
      case "tab": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(1);
        } else if (this.slashSuggestions.length > 0) {
          this.composerBuffer = `${this.slashSuggestions[this.suggestionIndex] ?? ""} `;
          this.composerCursor = this.composerBuffer.length;
          this.updateAutocompleteState();
          this.renderFrame();
        }
        return false;
      }
      case "interrupt": {
        if (!this.exitConfirmPending) {
          this.exitConfirmPending = true;
          this.showInterruptHint(SHELL_EXIT_CONFIRM_HINT);
          return true;
        }

        this.exitConfirmPending = false;
        this.clearInterruptHint();

        if (this.promptResolver) {
          const resolver = this.promptResolver;
          this.promptResolver = null;
          this.activeSelectionPrompt = null;
          this.composerBuffer = "/quit";
          this.composerCursor = 0;
          this.suggestionIndex = 0;
          this.slashSuggestions = [];
          this.transcriptScrollOffset = 0;
          this.renderFrame();
          resolver("/quit");
        } else {
          void this.close();
          process.exit(0);
        }
        return true;
      }
      case "eof": {
        if (!this.promptResolver && !this.composerBuffer) {
          void this.close();
          process.exit(0);
          return true;
        }
        return false;
      }
      case "backspace": {
        if (!this.activeSelectionPrompt) {
          this.deleteBeforeCursor();
        }
        return false;
      }
      case "delete": {
        if (!this.activeSelectionPrompt) {
          this.deleteAfterCursor();
        }
        return false;
      }
      case "left": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(-1);
        } else {
          this.moveCursorLeft();
        }
        return false;
      }
      case "right": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(1);
        } else {
          this.moveCursorRight();
        }
        return false;
      }
      case "home": {
        if (this.activeSelectionPrompt) {
          this.moveSelectionToEdge("start");
        } else {
          this.moveCursorHome();
        }
        return false;
      }
      case "end": {
        if (this.activeSelectionPrompt) {
          this.moveSelectionToEdge("end");
        } else {
          this.moveCursorEnd();
        }
        return false;
      }
      case "page-up":
        this.scrollTranscriptUp(10);
        return false;
      case "page-down":
        this.scrollTranscriptDown(10);
        return false;
      case "shift-tab": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(-1);
        }
        return false;
      }
      case "up": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(-1);
        } else if (this.slashSuggestions.length > 0) {
          this.suggestionIndex =
            (this.suggestionIndex - 1 + this.slashSuggestions.length) %
            this.slashSuggestions.length;
          this.renderFrame();
        } else {
          this.scrollTranscriptUp(1);
        }
        return false;
      }
      case "down": {
        if (this.activeSelectionPrompt) {
          this.moveSelection(1);
        } else if (this.slashSuggestions.length > 0) {
          this.suggestionIndex =
            (this.suggestionIndex + 1) % this.slashSuggestions.length;
          this.renderFrame();
        } else {
          this.scrollTranscriptDown(1);
        }
        return false;
      }
      case "escape": {
        if (this.activeSelectionPrompt) {
          return false;
        }

        if (this.slashSuggestions.length > 0) {
          this.slashSuggestions = [];
          this.suggestionIndex = 0;
          this.renderFrame();
        } else {
          this.composerBuffer = "";
          this.composerCursor = 0;
          this.renderFrame();
        }
        return false;
      }
      case "paste":
        if (!this.activeSelectionPrompt) {
          this.insertAtCursor(event.text);
        }
        return false;
      case "text": {
        if (this.activeSelectionPrompt) {
          const matched = resolvePromptSelection(
            this.activeSelectionPrompt.request,
            event.text
          );

          if (matched) {
            this.submitActiveSelection(matched);
            return true;
          }

          return false;
        }

        this.insertAtCursor(event.text);
        return false;
      }
    }
  }

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
    this.waitingHighlightStep = 0;
    this.renderFrame();

    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
    }

    this.waitingTimer = setInterval(() => {
      this.waitingFrame = (this.waitingFrame + 1) % WAITING_FRAMES.length;
      this.waitingHighlightStep += SHELL_WAIT_HIGHLIGHT_STEP;
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
      this.waitingHighlightStep = 0;
      this.renderFrame();
    }
  }

  beginAssistantReplyStream(): void {
    this.clearWaitingIndicator();
    this.transcript.beginActiveAssistantCell();
    this.renderFrame();
  }

  appendAssistantReplyDelta(delta: string): void {
    if (delta.length === 0) {
      return;
    }

    this.clearWaitingIndicator();
    this.transcript.appendActiveAssistantDelta(delta);
    this.renderFrame();
  }

  finishAssistantReplyStream(commit: boolean): void {
    if (commit) {
      this.transcript.commitActiveCell();
    } else {
      this.transcript.clearActiveCell();
    }

    this.renderFrame();
  }

  async writeAssistantReply(text: string, signal?: AbortSignal): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.beginAssistantReplyStream();

    try {
      const tokens = /\s/.test(trimmed)
        ? trimmed.match(/\S+\s*/g) ?? [trimmed]
        : [...trimmed];

      for (const token of tokens) {
        throwIfAborted(signal);
        this.appendAssistantReplyDelta(token);
        await new Promise((resolve) => setTimeout(resolve, SHELL_STREAM_DELAY_MS));
      }

      throwIfAborted(signal);
      this.finishAssistantReplyStream(true);
    } catch (error) {
      this.finishAssistantReplyStream(false);
      throw error;
    }
  }

  writeAssistantReplyNow(text: string): void {
    this.clearWaitingIndicator();
    this.appendEntry({ kind: "assistant", text });
  }

  writeAlert(text: string): void {
    this.clearWaitingIndicator();
    this.appendEntry({ kind: "alert", text });
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
      kind: study ? "study-card" : "data",
      text,
      dataKind: kind,
      study
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
          dataKind: "plain"
        });
      },
      writeDataBlock: (
        text: string,
        kind: CliDataKind,
        study?: StudyCellIntent
      ) => {
        this.writeDataBlock(text, kind, study);
      },
      select: (request: PromptSelectionRequest) => this.promptWithSelection(request),
      prompt: (promptText: string) => this.promptWithLabel(promptText),
      close: () => {}
    };
  }

  close(): Promise<void> | void {
    this.clearWaitingIndicator();
    this.exitConfirmPending = false;
    this.interruptHint = null;
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    this.inputBuffer = "";
    this.bracketedPasteBuffer = null;
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
    this.composerCursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    this.writeInputDebug("prompt-armed", {
      deferredSubmit: this.deferredPromptSubmit,
      draftLength: this.composerBuffer.length
    });
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

  private async promptWithSelection(
    request: PromptSelectionRequest
  ): Promise<string> {
    this.activePromptLabel = request.promptText;
    this.composerBuffer = "";
    this.composerCursor = 0;
    this.renderFrame();

    try {
      if (this.canUseInlineComposer()) {
        return await new Promise<string>((resolve) => {
          this.activeSelectionPrompt = {
            request,
            selectedIndex: this.resolveInitialSelectionIndex(request),
            resolve
          };
          this.renderFrame();
        });
      }

      return await this.terminal.prompt(
        this.theme.prompt(formatPromptSelectionPrompt(request))
      );
    } finally {
      this.activeSelectionPrompt = null;
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
      this.renderFrame();
      if (this.deferredPromptSubmit) {
        this.writeInputDebug("deferred-submit-replayed", {
          buffered: this.previewDebugValue(this.composerBuffer),
          length: this.composerBuffer.length
        });
        this.commitPromptSubmission();
      }
    });
  }

  private resolveInitialSelectionIndex(request: PromptSelectionRequest): number {
    if (!request.initialValue) {
      return 0;
    }

    const index = request.choices.findIndex(
      (choice) => choice.value === request.initialValue
    );

    return index >= 0 ? index : 0;
  }

  private moveSelection(delta: number): void {
    if (!this.activeSelectionPrompt) {
      return;
    }

    const choiceCount = this.activeSelectionPrompt.request.choices.length;
    if (choiceCount === 0) {
      return;
    }

    this.activeSelectionPrompt.selectedIndex =
      (this.activeSelectionPrompt.selectedIndex + delta + choiceCount) % choiceCount;
    this.renderFrame();
  }

  private moveSelectionToEdge(edge: "start" | "end"): void {
    if (!this.activeSelectionPrompt) {
      return;
    }

    this.activeSelectionPrompt.selectedIndex =
      edge === "start"
        ? 0
        : Math.max(0, this.activeSelectionPrompt.request.choices.length - 1);
    this.renderFrame();
  }

  private submitActiveSelection(forcedValue?: string): void {
    if (!this.activeSelectionPrompt) {
      return;
    }

    const prompt = this.activeSelectionPrompt;
    const choice = forcedValue
      ? prompt.request.choices.find((entry) => entry.value === forcedValue)
      : prompt.request.choices[prompt.selectedIndex];

    if (!choice) {
      return;
    }

    this.activeSelectionPrompt = null;
    prompt.resolve(choice.value);
  }

  private commitPromptSubmission(): boolean {
    if (!this.promptResolver) {
      return false;
    }

    const submitted = this.composerBuffer;
    if (submitted.trim().length === 0) {
      this.deferredPromptSubmit = false;
      return false;
    }

    const resolver = this.promptResolver;
    this.promptResolver = null;
    this.deferredPromptSubmit = false;
    this.composerBuffer = "";
    this.composerCursor = 0;
    this.suggestionIndex = 0;
    this.slashSuggestions = [];

    this.appendEntry({ kind: "user-line", text: submitted });
    resolver(submitted);
    return true;
  }

  private insertAtCursor(text: string): void {
    if (text.length === 0) {
      return;
    }

    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    this.composerBuffer = `${this.composerBuffer.slice(0, cursor)}${text}${this.composerBuffer.slice(cursor)}`;
    this.composerCursor = cursor + text.length;
    this.updateAutocompleteState();
    this.transcriptScrollOffset = 0;
    this.resetBlink();
    this.renderFrame();
  }

  private resetBlink(): void {
    return;
  }

  private deleteBeforeCursor(): void {
    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    if (cursor <= 0) {
      return;
    }

    const start = previousGraphemeBoundary(this.composerBuffer, cursor);
    this.composerBuffer = `${this.composerBuffer.slice(0, start)}${this.composerBuffer.slice(cursor)}`;
    this.composerCursor = start;
    this.updateAutocompleteState();
    this.resetBlink();
    this.renderFrame();
  }

  private deleteAfterCursor(): void {
    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    if (cursor >= this.composerBuffer.length) {
      return;
    }

    const end = nextGraphemeBoundary(this.composerBuffer, cursor);
    this.composerBuffer = `${this.composerBuffer.slice(0, cursor)}${this.composerBuffer.slice(end)}`;
    this.composerCursor = cursor;
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
    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    if (cursor <= 0) {
      return;
    }

    this.composerCursor = previousGraphemeBoundary(this.composerBuffer, cursor);
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorRight(): void {
    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    if (cursor >= this.composerBuffer.length) {
      return;
    }

    this.composerCursor = nextGraphemeBoundary(this.composerBuffer, cursor);
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorHome(): void {
    this.composerCursor = 0;
    this.resetBlink();
    this.renderFrame();
  }

  private moveCursorEnd(): void {
    this.composerCursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerBuffer.length
    );
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
    const composerRender = this.renderComposer(columns);
    const composerLines = composerRender.lines;
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
      .map(line => `${line}\u001b[K`)
      .join("\n");

    const composerCursorPosition = composerRender.cursorPosition
      ? {
          row:
            headerLines.length +
            1 +
            tipLines.length +
            transcriptLines.length +
            1 +
            statusLines.length +
            composerRender.cursorPosition.row,
          column: composerRender.cursorPosition.column
        }
      : null;

    const cursorSequence = composerCursorPosition
      ? formatCursorPosition(
          Math.min(rows - 1, composerCursorPosition.row),
          Math.min(columns - 1, composerCursorPosition.column)
        )
      : "";

    const cursorVisibility =
      composerCursorPosition && this.promptResolver
        ? ANSI_SHOW_CURSOR
        : ANSI_HIDE_CURSOR;

    this.terminal.writeRaw(`${ANSI_HOME}${frame}${cursorSequence}${cursorVisibility}`);
  }

  private renderTranscript(columns: number, height: number): string[] {
    const snapshot = this.transcript.snapshot();
    const rendered = snapshot.committedCells.flatMap((cell, i) => {
      const lines = this.renderCellLines(cell, columns);
      const prevCell = snapshot.committedCells[i - 1];
      const keepTight =
        i > 0 &&
        cell.kind === "study-card" &&
        prevCell?.kind === "study-card";

      return i > 0 && !keepTight ? ["", ...lines] : lines;
    });

    if (snapshot.activeCell && snapshot.activeCell.text.trim().length > 0) {
      if (rendered.length > 0) {
        rendered.push("");
      }
      rendered.push(...this.renderCellLines({
        id: 0,
        kind: snapshot.activeCell.kind,
        text: snapshot.activeCell.text
      }, columns, true));
    }

    if (rendered.length === 0) {
      return this.renderLandingState(columns, height);
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

  private renderLandingState(columns: number, height: number): string[] {
    const content = this.renderLandingHero(columns);

    const visible = content.slice(0, height);
    const remaining = Math.max(0, height - visible.length);
    const topPadding = Math.floor(remaining / 2);
    const bottomPadding = remaining - topPadding;

    return [
      ...Array.from({ length: topPadding }, () => ""),
      ...visible,
      ...Array.from({ length: bottomPadding }, () => "")
    ];
  }

  private renderLandingHero(columns: number): string[] {
    return [
      this.theme.heading(
        this.centerDisplayLine(`✦ ${this.displayName}'s Study Nook ✦`, columns)
      ),
      this.theme.status(
        this.centerDisplayLine(
          `Save one word, ask one question, and let ${this.displayName} keep it warm.`,
          columns
        )
      )
    ];
  }

  private renderCellLines(
    entry: ShellTranscriptCell,
    columns: number,
    active = false
  ): string[] {
    if (entry.kind === "study-card") {
      return this.renderStudyCard(entry, columns);
    }

    const sourceLines = entry.text.split("\n");
    const output: string[] = [];

    sourceLines.forEach((sourceLine, sourceIndex) => {
      switch (entry.kind) {
        case "assistant": {
          const firstPrefix = sourceIndex === 0 ? "• " : "  ";
          const continuationPrefix = "  ";
          const wrappedLines = wrapDisplayTextWithPrefixes(
            sourceLine,
            Math.max(8, columns - visibleDisplayWidth(firstPrefix)),
            Math.max(8, columns - visibleDisplayWidth(continuationPrefix))
          );
          const lineGraphemes = splitGraphemes(sourceLine);
          const highlightLength =
            active && this.streamHighlight
              ? resolveHighlightLength(lineGraphemes.length, this.streamHighlight)
              : 0;
          const highlightStart = Math.max(0, lineGraphemes.length - highlightLength);
          let consumedGraphemes = 0;

          wrappedLines.forEach((line, wrappedIndex) => {
            const prefix = wrappedIndex === 0 ? firstPrefix : continuationPrefix;
            const lineChars = splitGraphemes(line);
            const lineStart = consumedGraphemes;
            const lineEnd = lineStart + lineChars.length;
            consumedGraphemes = lineEnd;

            if (!active || !this.streamHighlight || lineEnd <= highlightStart) {
              output.push(
                `${this.theme.assistantLine(prefix)}${this.theme.assistantLine(line)}`
              );
              return;
            }

            const activeStartInLine = Math.max(0, highlightStart - lineStart);
            const before = lineChars.slice(0, activeStartInLine).join("");
            const highlighted = lineChars.slice(activeStartInLine).join("");
            output.push(
              [
                this.theme.assistantLine(prefix),
                this.theme.assistantLine(before),
                this.theme.assistantAccent(highlighted)
              ].join("")
            );
          });
          break;
        }
        case "user-line": {
          const firstPrefix = sourceIndex === 0 ? "› " : "  ";
          const continuationPrefix = "  ";
          const wrappedLines = wrapDisplayTextWithPrefixes(
            sourceLine,
            Math.max(8, columns - visibleDisplayWidth(firstPrefix)),
            Math.max(8, columns - visibleDisplayWidth(continuationPrefix))
          );

          wrappedLines.forEach((line, wrappedIndex) => {
            const prefix = wrappedIndex === 0 ? firstPrefix : continuationPrefix;
            const visibleW = visibleDisplayWidth(`${prefix}${line}`);
            const padR = Math.max(0, columns - visibleW);
            output.push(this.theme.userLineBg(`${prefix}${line}${" ".repeat(padR)}`));
          });
          break;
        }
        default: {
          const maxWidth = Math.max(12, columns);
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
              case "alert":
                output.push(this.theme.error(line));
                break;
              case "help":
                output.push(this.theme.muted(line));
                break;
              case "data":
                output.push(line);
                break;
              case "study-card":
              case "assistant":
              case "user-line":
                break;
            }
          });
          break;
        }
      }
    });

    return output;
  }

  private renderStatusLine(columns: number): string[] {
    if (this.waitingText === null) {
      if (this.activeSelectionPrompt) {
        return this.renderSelectionStatus(columns);
      }

      return [];
    }

    const frame = WAITING_FRAMES[this.waitingFrame] ?? "•";
    const prefix = `${frame} ${this.waitingLabel ?? "PawMemo"}  `;
    const fittedWaitingText = this.fitLine(
      this.waitingText,
      Math.max(1, columns - visibleDisplayWidth(prefix))
    );
    const { before, active, after } = splitSweepingHighlight(
      fittedWaitingText,
      this.waitingHighlightStep,
      this.streamHighlight
    );

    return [
      [
        this.theme.status(prefix),
        this.theme.status(before),
        this.theme.statusAccent(active),
        this.theme.status(after)
      ].join("")
    ];
  }

  private renderStudyCard(entry: ShellTranscriptCell, columns: number): string[] {
    const study = entry.study;
    const cardWidth = Math.min(76, Math.max(40, columns - 10));
    const innerWidth = Math.max(12, cardWidth - 4);
    const sections = study?.view?.sections;
    const bodyLines: string[] = sections && sections.length > 0
      ? this.renderStructuredStudyCardSections(study, sections, innerWidth)
      : [];

    if (!sections || sections.length === 0) {
      const sourceLines = entry.text.split("\n");
      sourceLines.forEach((sourceLine, sourceIndex) => {
        const wrappedLines = wrapDisplayText(sourceLine, innerWidth);

        wrappedLines.forEach((line, wrappedIndex) => {
          bodyLines.push(
            this.styleStudyCardLine(study, line, sourceIndex, wrappedIndex)
          );
        });
      });
    }

    const paddedLines = [
      this.theme.reviewCardBg(" ".repeat(cardWidth)),
      ...bodyLines.map((line) => {
        const visibleW = visibleDisplayWidth(line);
        const padR = Math.max(0, innerWidth - visibleW);
        return this.theme.reviewCardBg(`  ${line}${" ".repeat(padR + 2)}`);
      }),
      this.theme.reviewCardBg(" ".repeat(cardWidth))
    ];
    const leftPadding = Math.max(0, Math.floor((columns - cardWidth) / 2));

    return paddedLines.map((line) => `${" ".repeat(leftPadding)}${line}`);
  }

  private renderStructuredStudyCardSections(
    study: ShellStudyCellPayload | undefined,
    sections: StudyCardSection[],
    innerWidth: number
  ): string[] {
    const bodyLines: string[] = [];

    sections.forEach((section, sectionIndex) => {
      const nextRole = sections[sectionIndex + 1]?.role;
      const previousRole = sections[sectionIndex - 1]?.role;
      const needsGap =
        bodyLines.length > 0 &&
        this.studyCardNeedsSectionGap(previousRole, section.role);

      if (needsGap) {
        bodyLines.push("");
      }

      const renderedLines = this.renderStudyCardSection(
        study,
        section,
        innerWidth,
        sectionIndex
      );

      bodyLines.push(...renderedLines);

      const closesTitleBlock =
        section.role === "title"
          ? nextRole !== "subtitle"
          : section.role === "subtitle" && previousRole === "title";

      if (closesTitleBlock) {
        bodyLines.push(
          this.theme.muted(this.centerStudyCardLine("─".repeat(Math.min(20, innerWidth)), innerWidth))
        );
      }
    });

    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") {
      bodyLines.pop();
    }

    return bodyLines;
  }

  private renderStudyCardSection(
    study: ShellStudyCellPayload | undefined,
    section: StudyCardSection,
    innerWidth: number,
    sectionIndex: number
  ): string[] {
    const sourceLines = section.text.split("\n");
    const output: string[] = [];

    sourceLines.forEach((sourceLine, sourceIndex) => {
      const wrappedLines = wrapDisplayText(sourceLine, innerWidth);
      wrappedLines.forEach((line, wrappedIndex) => {
        output.push(
          this.styleStudyCardSectionLine(
            study,
            section.role,
            line,
            sectionIndex,
            sourceIndex,
            wrappedIndex,
            innerWidth
          )
        );
      });
    });

    return output;
  }

  private studyCardNeedsSectionGap(
    previousRole: StudyCardSection["role"] | undefined,
    nextRole: StudyCardSection["role"]
  ): boolean {
    if (!previousRole) {
      return false;
    }

    if (nextRole === "eyebrow" || nextRole === "title") {
      return true;
    }

    if (previousRole === "title" && nextRole === "subtitle") {
      return false;
    }

    if (previousRole === "title") {
      return true;
    }

    if (previousRole === "subtitle") {
      return true;
    }

    return previousRole !== nextRole && (nextRole === "meta" || nextRole === "note");
  }

  private styleStudyCardSectionLine(
    study: ShellStudyCellPayload | undefined,
    role: "eyebrow" | "title" | "subtitle" | "prompt" | "answer" | "note" | "meta",
    line: string,
    sectionIndex: number,
    sourceIndex: number,
    wrappedIndex: number,
    innerWidth: number
  ): string {
    const sections = study?.view?.sections ?? [];
    const previousRole = sections[sectionIndex - 1]?.role;
    const indentedLine =
      previousRole === "eyebrow" && role !== "eyebrow"
        ? `  ${line}`
        : line;

    switch (role) {
      case "eyebrow":
        return this.theme.muted(
          wrappedIndex === 0
            ? this.formatStudyCardLabel(line)
            : line
        );
      case "title":
        return this.theme.heading(
          this.centerStudyCardLine(line, innerWidth)
        );
      case "subtitle":
        return this.theme.muted(
          this.centerStudyCardLine(line, innerWidth)
        );
      case "answer":
        return sourceIndex === 0 && wrappedIndex === 0
          ? this.theme.prompt(indentedLine)
          : this.theme.assistantAccent(indentedLine);
      case "note":
        return this.theme.muted(indentedLine);
      case "meta":
        return this.theme.muted(indentedLine);
      case "prompt":
        if (
          study?.kind === "review-card" &&
          study.emphasis &&
          line.includes(study.emphasis)
        ) {
          return this.theme.assistantAccent(indentedLine);
        }

        return this.theme.assistantLine(indentedLine);
    }
  }

  private formatStudyCardLabel(text: string): string {
    const normalized =
      /[A-Za-z]/.test(text) && !/[\u3400-\u9fff]/.test(text)
        ? text.toUpperCase()
        : text;

    return `◆ ${normalized}`;
  }

  private styleStudyCardLine(
    study: ShellStudyCellPayload | undefined,
    line: string,
    sourceIndex: number,
    wrappedIndex: number
  ): string {
    const isFirstLine = sourceIndex === 0 && wrappedIndex === 0;

    switch (study?.kind) {
      case "review-intro":
      case "rescue-intro":
        return isFirstLine
          ? this.theme.assistantAccent(line)
          : this.theme.assistantLine(line);
      case "review-card":
        if (isFirstLine) {
          return this.theme.assistantAccent(line);
        }

        if (study.emphasis && line.includes(study.emphasis)) {
          return this.theme.assistantAccent(line);
        }

        return this.theme.assistantLine(line);
      case "review-summary":
        return isFirstLine
          ? this.theme.assistantAccent(line)
          : this.theme.assistantLine(line);
      default:
        return line;
    }
  }

  private renderComposer(columns: number): {
    lines: string[];
    cursorPosition: { row: number; column: number } | null;
  } {
    if (this.activeSelectionPrompt) {
      return {
        lines: this.renderSelectionComposer(columns),
        cursorPosition: null
      };
    }

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
    const visibleW = visibleDisplayWidth(composerLine.line);
    
    const padR = Math.max(0, columns - visibleW);
    const padded = `${composerLine.line}${" ".repeat(padR)}`;
    
    lines.push(padded);
    return {
      lines,
      cursorPosition: {
        row: lines.length - 1,
        column: composerLine.cursorColumn
      }
    };
  }

  private renderSelectionStatus(columns: number): string[] {
    if (!this.activeSelectionPrompt) {
      return [];
    }

    return [
      this.theme.status(
        this.fitLine(
          `${this.activeSelectionPrompt.request.promptText}  ${this.activeSelectionPrompt.selectedIndex + 1}/${this.activeSelectionPrompt.request.choices.length}  Tab/↑/↓ choose · Enter confirm`,
          columns
        )
      )
    ];
  }

  private renderSelectionComposer(columns: number): string[] {
    if (!this.activeSelectionPrompt) {
      return [];
    }

    const choices = this.activeSelectionPrompt.request.choices;
    const selectedIndex = Math.max(0, Math.min(this.activeSelectionPrompt.selectedIndex, choices.length - 1));

    if (choices.length === 0) {
      const emptyLine = this.theme.muted(this.fitLine("No choices available.", columns));
      const emptyWidth = visibleDisplayWidth(emptyLine);
      return [`${emptyLine}${" ".repeat(Math.max(0, columns - emptyWidth))}`];
    }

    const visibleCount = Math.min(MAX_VISIBLE_SELECTION_CHOICES, choices.length);
    const maxStart = Math.max(0, choices.length - visibleCount);
    const startIndex = Math.max(
      0,
      Math.min(
        selectedIndex - Math.floor(visibleCount / 2),
        maxStart
      )
    );
    const endIndex = Math.min(choices.length, startIndex + visibleCount);
    const lines: string[] = [];

    if (startIndex > 0) {
      const moreAbove = this.theme.muted(
        this.fitLine(`↑ ${startIndex} more`, columns)
      );
      lines.push(`${moreAbove}${" ".repeat(Math.max(0, columns - visibleDisplayWidth(moreAbove)))}`);
    }

    choices.slice(startIndex, endIndex).forEach((choice, visibleIndex) => {
      const index = startIndex + visibleIndex;
      const isSelected = index === selectedIndex;
      const alias = choice.aliases?.[0]?.toUpperCase();
      const prefix = isSelected ? "› " : "  ";
      const aliasPart = alias ? `(${alias}) ` : "";
      const label = `${prefix}${aliasPart}${choice.label}`;
      const description = choice.description?.trim() ?? "";
      const labelWidth = visibleDisplayWidth(label);
      let line = label;

      if (description.length > 0 && columns - labelWidth - 1 >= 8) {
        const descriptionWidth = Math.max(8, columns - labelWidth - 1);
        const clippedDescription =
          stringDisplayWidth(description) > descriptionWidth
            ? `${description.slice(0, Math.max(0, descriptionWidth - 1))}…`
            : description;
        line = `${label} ${clippedDescription}`;
      }

      const fitted = this.fitLine(line, columns);
      const padR = Math.max(0, columns - visibleDisplayWidth(fitted));

      if (isSelected) {
        lines.push(`\u001b[48;5;236m${this.theme.prompt(fitted)}${" ".repeat(padR)}\u001b[0m`);
      } else {
        lines.push(`${this.theme.muted(fitted)}${" ".repeat(padR)}`);
      }
    });

    if (endIndex < choices.length) {
      const moreBelow = this.theme.muted(
        this.fitLine(`↓ ${choices.length - endIndex} more`, columns)
      );
      lines.push(`${moreBelow}${" ".repeat(Math.max(0, columns - visibleDisplayWidth(moreBelow)))}`);
    }

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
    if (this.interruptHint) {
      return [this.theme.muted(this.fitLine(this.interruptHint, columns - 1))];
    }

    if (!this.activeCompanionLine) {
        return [];
    }
    // Use columns-1 for the bottom-most line of the screen to prevent terminal from
    // auto-scrolling when writing to the last cell.
    return [
        this.theme.companionLine(this.fitLine(this.activeCompanionLine, columns - 1))
    ];
  }

  private renderComposerInput(columns: number): ComposerRenderResult {
    const prompt = `${this.activePromptLabel}`;
    const cursor = clampToNearestGraphemeBoundary(
      this.composerBuffer,
      this.composerCursor
    );
    const displayBefore = composerDisplayText(
      this.composerBuffer.slice(0, cursor)
    );
    const displayAfter = composerDisplayText(
      this.composerBuffer.slice(cursor)
    );
    const promptWidth = visibleDisplayWidth(prompt);
    // Keep it explicitly shorter by 1 to prevent terminal auto-wrap from scrolling the screen
    const maxContentWidth = Math.max(1, columns - promptWidth - 1);
    const viewport = fitComposerViewport(displayBefore, displayAfter, maxContentWidth);
    const line = `${this.theme.heading(prompt)}${viewport.before}${viewport.after}`;

    return {
      line,
      cursorColumn: Math.min(
        columns - 1,
        promptWidth + visibleDisplayWidth(viewport.before)
      )
    };
  }

  private tailDisplayText(text: string, maxWidth: number): string {
    if (stringDisplayWidth(text) <= maxWidth) {
      return text;
    }

    let out = "";
    const reversed = splitGraphemes(text).reverse();

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
    for (const char of splitGraphemes(text)) {
      const candidate = `${out}${char}`;
      if (stringDisplayWidth(`${candidate}…`) > columns) {
        break;
      }
      out = candidate;
    }

    return `${out}…`;
  }

  private centerDisplayLine(text: string, columns: number): string {
    const fitted = this.fitLine(text, columns);
    const missingWidth = Math.max(0, columns - stringDisplayWidth(fitted));
    const leftPadding = Math.floor(missingWidth / 2);
    const rightPadding = missingWidth - leftPadding;

    return `${" ".repeat(leftPadding)}${fitted}${" ".repeat(rightPadding)}`;
  }

  private centerStudyCardLine(text: string, width: number): string {
    const fitted = this.fitLine(text, width);
    const missingWidth = Math.max(0, width - stringDisplayWidth(fitted));
    const leftPadding = Math.floor(missingWidth / 2);
    const rightPadding = missingWidth - leftPadding;

    return `${" ".repeat(leftPadding)}${fitted}${" ".repeat(rightPadding)}`;
  }

  private previewDebugValue(value: string): string {
    const normalized = composerDisplayText(value);
    return normalized.length > 48
      ? `${normalized.slice(0, 47)}…`
      : normalized;
  }

  private writeInputDebug(
    event: string,
    fields: Record<string, string | number | boolean | null | undefined>
  ): void {
    if (!this.debugEnabled) {
      return;
    }

    const lines = [`Input Debug: ${event}`];

    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) {
        continue;
      }

      lines.push(`${key}: ${String(value)}`);
    }

    this.appendEntry({
      kind: "data",
      text: lines.join("\n"),
      dataKind: "plain"
    });
  }
}
