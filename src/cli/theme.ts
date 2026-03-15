interface StreamLike {
  isTTY?: boolean;
}

interface ThemeOptions {
  enabled: boolean;
}

const RESET = "\u001b[0m";

function applyAnsi(
  enabled: boolean,
  text: string,
  codes: number[]
): string {
  if (!enabled || text.length === 0) {
    return text;
  }

  const codeStr = `\u001b[${codes.join(";")}m`;
  return `${codeStr}${text.split(RESET).join(`${RESET}${codeStr}`)}${RESET}`;
}

function styleLabelLine(
  line: string,
  styleLabel: (text: string) => string,
  styleValue?: (text: string) => string
): string {
  const match = /^(\s*)([^:]+:)(\s*)(.*)$/.exec(line);

  if (!match) {
    return line;
  }

  const [, indent, label, gap, value] = match;
  const renderedValue = styleValue ? styleValue(value) : value;
  return `${indent}${styleLabel(label)}${gap}${renderedValue}`;
}

export function shouldUseColor(
  stream: StreamLike,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if ("NO_COLOR" in env) {
    return false;
  }

  const forceColor = env.FORCE_COLOR?.trim();

  if (forceColor === "0") {
    return false;
  }

  if (forceColor && forceColor !== "0") {
    return true;
  }

  if (!stream.isTTY) {
    return false;
  }

  return env.TERM !== "dumb";
}

export interface CliTheme {
  readonly enabled: boolean;
  heading(text: string): string;
  muted(text: string): string;
  prompt(text: string): string;
  status(text: string): string;
  statusAccent(text: string): string;
  error(text: string): string;
  assistantLine(text: string): string;
  assistantAccent(text: string): string;
  companionCard(text: string): string;
  companionLine(text: string): string;
  reviewCardBg(text: string): string;
  userLineBg(text: string): string;
  help(text: string): string;
  dataBlock(text: string, kind?: CliDataKind): string;
}

export type CliDataKind =
  | "plain"
  | "capture-result"
  | "review-queue"
  | "review-next"
  | "review-reveal"
  | "review-session-heading"
  | "review-session-status-success"
  | "review-session-status-warning"
  | "review-card-heading"
  | "review-card-field"
  | "review-summary"
  | "return-summary"
  | "rescue"
  | "grade-result"
  | "ask-result"
  | "teach-result"
  | "card-workspace"
  | "stats"
  | "recovery"
  | "home"
  | "settings"
  | "llm-status"
  | "llm-model-list"
  | "companion-packs";

export function createCliTheme(options: ThemeOptions): CliTheme {
  const { enabled } = options;

  const heading = (text: string): string => applyAnsi(enabled, text, [1, 36]);
  const section = (text: string): string => applyAnsi(enabled, text, [36]);
  const command = (text: string): string => applyAnsi(enabled, text, [36]);
  const muted = (text: string): string => applyAnsi(enabled, text, [90]);
  const prompt = (text: string): string => applyAnsi(enabled, text, [1, 36]);
  const status = (text: string): string => applyAnsi(enabled, text, [96]);
  const statusAccent = (text: string): string => applyAnsi(enabled, text, [1, 97]);
  const success = (text: string): string => applyAnsi(enabled, text, [32]);
  const warning = (text: string): string => applyAnsi(enabled, text, [33]);
  const error = (text: string): string => applyAnsi(enabled, text, [1, 31]);
  const assistantLine = (text: string): string => applyAnsi(enabled, text, [97]);
  const assistantAccent = (text: string): string => applyAnsi(enabled, text, [96]);
  const companionHeader = (text: string): string => applyAnsi(enabled, text, [1, 35]);
  const companionBody = (text: string): string => applyAnsi(enabled, text, [95]);
  const reviewCardBg = (text: string): string => applyAnsi(enabled, text, [48, 5, 236]);
  const userLineBg = (text: string): string => applyAnsi(enabled, text, [48, 5, 238]);

  const help = (text: string): string =>
    text
      .split("\n")
      .map((line) => {
        if (line === "PawMemo CLI" || line.startsWith("PawMemo shell")) {
          return heading(line);
        }

        if (
          line === "Commands:" ||
          line === "Examples:" ||
          line === "Shell commands:" ||
          line === "Natural input:" ||
          line === "Technical commands:"
        ) {
          return section(line);
        }

        const prefixedCommand = /^(\s+)(pawmemo .+)$/.exec(line);

        if (prefixedCommand) {
          return `${prefixedCommand[1]}${command(prefixedCommand[2])}`;
        }

        const shellCommand = /^(\s+)([a-z]+(?: [a-z]+)?(?: .*)?)$/.exec(line);

        if (shellCommand) {
          return `${shellCommand[1]}${command(shellCommand[2])}`;
        }

        return line;
      })
      .join("\n");

  const styleFieldLines = (lines: string[]): string[] =>
    lines.map((line) =>
      line.length === 0
        ? line
        : /^\s*[^:]+:\s/.test(line)
          ? styleLabelLine(line, muted)
          : line
    );

  const styleCommandFieldLines = (lines: string[]): string[] =>
    lines.map((line) =>
      line.length === 0
        ? line
        : /^\s*[^:]+:\s/.test(line)
          ? styleLabelLine(line, muted, command)
          : line
    );

  const dataBlock = (text: string, kind: CliDataKind = "plain"): string => {
    const lines = text.split("\n");

    switch (kind) {
      case "capture-result":
        return [
          success(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1))
        ].join("\n");
      case "review-next":
      case "review-reveal":
      case "review-summary":
      case "return-summary":
      case "rescue":
      case "ask-result":
      case "teach-result":
      case "card-workspace":
      case "recovery":
      case "home":
        return [
          heading(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1))
        ].join("\n");
      case "grade-result":
        return [
          success(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1))
        ].join("\n");
      case "stats":
        return [
          heading(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1, 4)),
          section(lines[4] ?? ""),
          ...styleFieldLines(lines.slice(5))
        ].join("\n");
      case "settings":
        return styleFieldLines(lines).join("\n");
      case "llm-status":
        return [
          heading(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1, 2)),
          section(lines[2] ?? ""),
          ...styleFieldLines(lines.slice(3, 6)),
          ...styleCommandFieldLines(lines.slice(6))
        ].join("\n");
      case "llm-model-list":
        return [
          heading(lines[0] ?? ""),
          ...styleFieldLines(lines.slice(1, 2)),
          ...lines.slice(2).map((line) => command(line))
        ].join("\n");
      case "companion-packs":
        return [
          heading(lines[0] ?? ""),
          ...lines.slice(1).map((line) => command(line))
        ].join("\n");
      case "review-session-heading":
        return heading(text);
      case "review-session-status-success":
        return success(text);
      case "review-session-status-warning":
        return warning(text);
      case "review-card-heading":
        return section(text);
      case "review-card-field":
        return /^\s*[^:]+:\s/.test(text) ? styleLabelLine(text, muted) : text;
      case "review-queue":
      case "plain":
      default:
        return styleFieldLines(lines).join("\n");
    }
  };

  const companionCard = (text: string): string => {
    const lines = text.split("\n");

    if (lines.length === 0) {
      return text;
    }

    return [
      companionHeader(lines[0] ?? ""),
      ...lines.slice(1).map((line) => companionBody(line))
    ].join("\n");
  };

  const companionLine = (text: string): string => companionBody(text);

  return {
    enabled,
    heading,
    muted,
    prompt,
    status,
    statusAccent,
    error,
    assistantLine,
    assistantAccent,
    companionCard,
    companionLine,
    reviewCardBg,
    userLineBg,
    help,
    dataBlock
  };
}
