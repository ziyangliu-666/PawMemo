import type {
  CompanionSignalsResult,
  HomeProjectionResult
} from "../core/domain/models";
import type { ShellSurface } from "./shell-surface";
import { presentShellStartupIntro } from "./shell-presenter";

export interface ShellStartupEntry {
  mood: "idle" | "curious" | "studying" | "proud" | "confused" | "sleepy";
  text: string | null;
}

export class ShellStartupCoordinator {
  createEntry(
    summary: CompanionSignalsResult,
    home: HomeProjectionResult
  ): ShellStartupEntry {
    return {
      mood: resolveStartupMood(home),
      text: presentShellStartupIntro(summary, home)
    };
  }

  renderEntry(surface: ShellSurface, entry: ShellStartupEntry): void {
    if (!entry.text) {
      return;
    }

    if (surface.seedTranscript) {
      surface.seedTranscript([
        {
          kind: "assistant",
          text: entry.text
        }
      ]);
      return;
    }

    surface.writeAssistantReplyNow(entry.text);
  }
}

function resolveStartupMood(
  home: HomeProjectionResult
): ShellStartupEntry["mood"] {
  switch (home.entryKind) {
    case "return_rescue":
    case "return_review":
    case "rescue":
    case "review":
      return "studying";
    case "resume_recent":
      return "curious";
    case "capture":
      return "idle";
  }
}
