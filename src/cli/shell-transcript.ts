import type { StudyCellIntent } from "./transcript-intent";
import type { CliDataKind } from "./theme";

export type ShellTranscriptCellKind =
  | "companion-card"
  | "companion-line"
  | "user-line"
  | "assistant"
  | "help"
  | "data"
  | "study";

export type ShellStudyCellKind = StudyCellIntent["kind"];
export type ShellStudyCellPayload = StudyCellIntent;

export interface ShellTranscriptCell {
  id: number;
  kind: ShellTranscriptCellKind;
  text: string;
  dataKind?: CliDataKind;
  study?: ShellStudyCellPayload;
}

export interface ShellActiveTranscriptCell {
  kind: "assistant";
  text: string;
}

export interface ShellTranscriptSnapshot {
  committedCells: ShellTranscriptCell[];
  activeCell: ShellActiveTranscriptCell | null;
}

export interface ShellTranscriptModelOptions {
  maxCommittedCells?: number;
}

const DEFAULT_MAX_COMMITTED_CELLS = 200;

export class ShellTranscriptModel {
  private readonly maxCommittedCells: number;
  private nextCellId = 1;
  private readonly committedCells: ShellTranscriptCell[] = [];
  private activeCell: ShellActiveTranscriptCell | null = null;

  constructor(options: ShellTranscriptModelOptions = {}) {
    this.maxCommittedCells = Math.max(
      1,
      options.maxCommittedCells ?? DEFAULT_MAX_COMMITTED_CELLS
    );
  }

  appendCommittedCell(
    kind: ShellTranscriptCellKind,
    text: string,
    dataKind?: CliDataKind,
    study?: ShellStudyCellPayload
  ): ShellTranscriptCell {
    const cell: ShellTranscriptCell = {
      id: this.nextCellId,
      kind,
      text,
      dataKind,
      study
    };

    this.nextCellId += 1;
    this.committedCells.push(cell);

    if (this.committedCells.length > this.maxCommittedCells) {
      this.committedCells.splice(
        0,
        this.committedCells.length - this.maxCommittedCells
      );
    }

    return cell;
  }

  beginActiveAssistantCell(): void {
    this.activeCell = {
      kind: "assistant",
      text: ""
    };
  }

  appendActiveAssistantDelta(delta: string): void {
    if (!this.activeCell) {
      this.beginActiveAssistantCell();
    }

    this.activeCell = {
      kind: "assistant",
      text: `${this.activeCell?.text ?? ""}${delta}`
    };
  }

  clearActiveCell(): void {
    this.activeCell = null;
  }

  commitActiveCell(): ShellTranscriptCell | null {
    const active = this.activeCell;

    if (!active || active.text.trim().length === 0) {
      this.activeCell = null;
      return null;
    }

    this.activeCell = null;
    return this.appendCommittedCell(active.kind, active.text);
  }

  snapshot(): ShellTranscriptSnapshot {
    return {
      committedCells: [...this.committedCells],
      activeCell: this.activeCell ? { ...this.activeCell } : null
    };
  }
}
