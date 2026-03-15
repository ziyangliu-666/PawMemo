import type { ShellSurface } from "./base-shell-surface";
import type {
  ShellAction,
  ShellAgentResponse
} from "./shell-contract";

export type ShellDebugField = string | number | boolean | null | undefined;

export function formatPerfMs(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)}s`;
  }

  if (value >= 100) {
    return `${value.toFixed(0)}ms`;
  }

  return `${value.toFixed(1)}ms`;
}

export function writeShellDebug(
  surface: Pick<ShellSurface, "writeDataBlock">,
  debugEnabled: boolean,
  event: string,
  fields: Record<string, ShellDebugField>
): void {
  if (!debugEnabled) {
    return;
  }

  const lines = [`Debug: ${event}`];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    lines.push(`${key}: ${String(value)}`);
  }

  surface.writeDataBlock(lines.join("\n"), "plain");
}

export function writeShellPerf(
  surface: Pick<ShellSurface, "writeDataBlock">,
  debugEnabled: boolean,
  event: string,
  elapsedMs: number,
  fields: Record<string, ShellDebugField>
): void {
  if (!debugEnabled) {
    return;
  }

  const lines = [`Perf: ${event}`, `elapsed: ${formatPerfMs(elapsedMs)}`];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }

    lines.push(`${key}: ${String(value)}`);
  }

  surface.writeDataBlock(lines.join("\n"), "plain");
}

export function describeShellAgentResponse(
  response: ShellAgentResponse
): Record<string, ShellDebugField> {
  if (response.kind === "message") {
    return {
      source: response.source,
      kind: response.kind,
      mood: response.mood,
      text: response.text
    };
  }

  return {
    source: response.source,
    kind: response.kind,
    action: response.action.kind
  };
}

export function describeShellAction(
  action: ShellAction
): Record<string, ShellDebugField> {
  switch (action.kind) {
    case "ask":
    case "capture":
    case "study-card-list":
    case "study-card-create":
    case "study-card-update":
    case "study-card-set-lifecycle":
    case "study-card-delete":
    case "teach-clarify-context":
    case "teach":
    case "teach-confirm":
      return {
        action: action.kind,
        word: "word" in action.input ? action.input.word : undefined,
        cardId: "selector" in action.input ? action.input.selector.cardId : undefined
      };
    case "command":
      return {
        action: action.kind,
        rawInput: action.rawInput
      };
    default:
      return {
        action: action.kind
      };
  }
}
