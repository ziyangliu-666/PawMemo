import type { PromptSelectionRequest } from "./review-session-runner";
import type {
  ShellTranscriptSnapshot
} from "./shell-transcript";

export interface ShellViewportSnapshot {
  columns: number;
  rows: number;
}

export interface ShellRegionSnapshot {
  top: number;
  height: number;
  lines: string[];
}

export interface ShellRenderedCursorSnapshot {
  row: number;
  column: number;
  visible: boolean;
}

export interface ShellSelectionChoiceSnapshot {
  value: string;
  label: string;
  description: string;
  selected: boolean;
  aliases: string[];
}

export interface ShellSelectionPromptSnapshot {
  promptText: string;
  selectedIndex: number;
  choices: ShellSelectionChoiceSnapshot[];
}

export interface ShellSlashSuggestionSnapshot {
  command: string;
  description: string;
  selected: boolean;
}

export interface ShellWaitingSnapshot {
  label: string;
  text: string;
  frameIndex: number;
  highlightStep: number;
}

export interface ShellComposerSnapshot {
  promptLabel: string;
  buffer: string;
  cursorIndex: number;
  promptArmed: boolean;
  promptEpoch: number;
  inlineInputEnabled: boolean;
  slashSuggestions: ShellSlashSuggestionSnapshot[];
  selectionPrompt: ShellSelectionPromptSnapshot | null;
  exitConfirmPending: boolean;
}

export interface ShellRenderedFrameSnapshot {
  lines: string[];
  frameText: string;
  styledLines: string[];
  cursor: ShellRenderedCursorSnapshot | null;
}

export interface ShellLayoutSnapshot {
  header: ShellRegionSnapshot;
  tip: ShellRegionSnapshot;
  transcript: ShellRegionSnapshot;
  status: ShellRegionSnapshot;
  composer: ShellRegionSnapshot;
  footer: ShellRegionSnapshot;
}

export interface ShellFrameSnapshot {
  displayName: string;
  shellMode: string;
  dueCount: number;
  viewport: ShellViewportSnapshot;
  transcript: ShellTranscriptSnapshot;
  waiting: ShellWaitingSnapshot | null;
  companionLine: string | null;
  interruptHint: string | null;
  composer: ShellComposerSnapshot;
  layout: ShellLayoutSnapshot;
  rendered: ShellRenderedFrameSnapshot;
}

export function toSelectionPromptSnapshot(
  request: PromptSelectionRequest,
  selectedIndex: number
): ShellSelectionPromptSnapshot {
  return {
    promptText: request.promptText,
    selectedIndex,
    choices: request.choices.map((choice, index) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description ?? "",
      selected: index === selectedIndex,
      aliases: choice.aliases ?? []
    }))
  };
}
