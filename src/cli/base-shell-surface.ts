import type { CliDataKind } from "./theme";
import type { StudyCellIntent } from "./transcript-intent";
import type {
  PromptSelectionRequest,
  ReviewSessionTerminal
} from "./review-session-runner";

const SHELL_STREAM_DELAY_MS = 8;
const SHELL_WAIT_FRAME_MS = 100;
const SHELL_WAIT_HIGHLIGHT_STEP = 4;

export const WAITING_FRAMES = ["·", "•", "●", "•"];

export interface ShellStreamHighlightConfig {
  percent: number;
  totalChars: number;
}

export interface ShellTerminal extends ReviewSessionTerminal {
  writeRaw?(text: string): void;
}

export interface ShellSurface {
  readonly supportsColor?: boolean;
  beginShell(displayName: string): void;
  close(): Promise<void> | void;
  prompt(): Promise<string>;
  seedTranscript?(
    entries: Array<{
      kind: string;
      text: string;
      dataKind?: CliDataKind;
      study?: StudyCellIntent;
    }>
  ): void;
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

export function resolveHighlightLength(
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

export function splitSweepingHighlight(
  text: string,
  tick: number,
  splitGraphemes: (value: string) => string[],
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

function splitAssistantReplyTokens(text: string): string[] {
  return /\s/.test(text)
    ? text.match(/\S+\s*/g) ?? [text]
    : [...text];
}

export abstract class BaseShellSurface implements ShellSurface {
  readonly supportsColor?: boolean;
  protected streamHighlight: ShellStreamHighlightConfig | null = null;
  protected waitingFrame = 0;
  protected waitingHighlightStep = 0;
  protected waitingLabel: string | null = null;
  protected waitingText: string | null = null;
  protected waitingSince: number | null = null;
  protected waitingTimer: NodeJS.Timeout | null = null;

  protected constructor(protected readonly terminal: ShellTerminal) {
    this.supportsColor = terminal.supportsColor;
  }

  abstract beginShell(displayName: string): void;
  abstract close(): Promise<void> | void;
  abstract prompt(): Promise<string>;
  abstract renderCompanionCard(text: string): void;
  abstract renderCompanionLine(text: string): void;
  abstract beginAssistantReplyStream(): void;
  abstract appendAssistantReplyDelta(delta: string): void;
  abstract finishAssistantReplyStream(commit: boolean): void;
  abstract writeAssistantReplyNow(text: string): void;
  abstract writeAlert(text: string): void;
  abstract writeHelp(text: string): void;
  abstract writeDataBlock(
    text: string,
    kind?: CliDataKind,
    study?: StudyCellIntent
  ): void;
  protected abstract renderFrame(): void;
  protected abstract writeReviewSessionLine(text: string): void;
  protected abstract promptWithLabel(promptText: string): Promise<string>;

  setMode(mode: string, dueCount?: number): void {
    void mode;
    void dueCount;
  }

  setStreamHighlight(config: ShellStreamHighlightConfig | null): void {
    this.streamHighlight = config;
    this.renderFrame();
  }

  showWaitingIndicator(label: string, text: string): void {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    this.waitingLabel = label;
    this.waitingText = trimmed;
    this.waitingSince = Date.now();
    this.waitingFrame = 0;
    this.waitingHighlightStep = 0;
    this.renderWaitingIndicator();

    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
    }

    if (!this.canAnimateWaitingIndicator()) {
      return;
    }

    this.waitingTimer = setInterval(() => {
      this.waitingFrame = (this.waitingFrame + 1) % WAITING_FRAMES.length;
      this.waitingHighlightStep += SHELL_WAIT_HIGHLIGHT_STEP;
      this.renderWaitingIndicator();
    }, SHELL_WAIT_FRAME_MS);
  }

  clearWaitingIndicator(): void {
    if (this.waitingTimer) {
      clearInterval(this.waitingTimer);
      this.waitingTimer = null;
    }

    if (
      this.waitingLabel === null &&
      this.waitingText === null &&
      this.waitingSince === null
    ) {
      return;
    }

    this.beforeClearWaitingIndicator();
    this.waitingLabel = null;
    this.waitingText = null;
    this.waitingSince = null;
    this.waitingFrame = 0;
    this.waitingHighlightStep = 0;
    this.afterClearWaitingIndicator();
  }

  async writeAssistantReply(
    text: string,
    signal?: AbortSignal
  ): Promise<void> {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      return;
    }

    if (!this.shouldStreamAssistantReply()) {
      this.clearWaitingIndicator();
      this.writeAssistantReplyNow(trimmed);
      return;
    }

    this.beginAssistantReplyStream();

    try {
      for (const token of splitAssistantReplyTokens(trimmed)) {
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

  createReviewSessionTerminal(): ReviewSessionTerminal {
    const select = this.createReviewSessionPromptSelect();

    return {
      supportsColor: this.supportsColor,
      setMode: (mode: string) => this.setMode(mode),
      write: (text: string) => {
        this.writeReviewSessionLine(text);
      },
      writeDataBlock: (
        text: string,
        kind: CliDataKind,
        study?: StudyCellIntent
      ) => {
        this.writeDataBlock(text, kind, study);
      },
      ...(select ? { select } : {}),
      prompt: (promptText: string) => this.promptWithLabel(promptText),
      close: () => {}
    };
  }

  protected shouldStreamAssistantReply(): boolean {
    return true;
  }

  protected canAnimateWaitingIndicator(): boolean {
    return true;
  }

  protected createReviewSessionPromptSelect():
    | ((request: PromptSelectionRequest) => Promise<string>)
    | undefined {
    return undefined;
  }

  protected renderWaitingIndicator(): void {
    this.renderFrame();
  }

  protected beforeClearWaitingIndicator(): void {}

  protected afterClearWaitingIndicator(): void {
    this.renderFrame();
  }
}
