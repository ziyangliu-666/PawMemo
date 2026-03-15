export type CompanionMood =
  | "idle"
  | "curious"
  | "studying"
  | "proud"
  | "confused"
  | "sleepy";

export type RomanceMode = "off" | "optional" | "on";

export type CompanionReactionKey =
  | "planner_wait"
  | "study_wait"
  | "help"
  | "pet_ping"
  | "stats_summary"
  | "capture_success"
  | "ask_ready"
  | "teach_success"
  | "rescue_candidate"
  | "rescue_complete"
  | "return_after_gap"
  | "review_next"
  | "review_reveal"
  | "review_session_complete"
  | "review_session_empty"
  | "review_session_paused"
  | "review_session_quit"
  | "command_error"
  | "idle_prompt"
  | "shell_exit";

export type CompanionDynamicTemplateKey =
  | "status_snapshot"
  | CompanionReactionKey;

export type CompanionDynamicTemplateBank =
  Partial<Record<CompanionDynamicTemplateKey, string>>;

export interface CompanionLineTemplateSet {
  default: string[];
  withRecentWord?: string[];
  withDueCards?: string[];
  withDueCardsAndRecentWord?: string[];
}

export interface CompanionPackDefinition {
  id: string;
  displayName: string;
  archetype?: string;
  styleLabel?: string;
  romanceMode: RomanceMode;
  description?: string;
  personality?: string;
  scenario?: string;
  exampleMessages?: string[];
  postHistoryInstructions?: string[];
  toneRules?: string[];
  boundaryRules?: string[];
  avatarFrames?: Partial<Record<CompanionMood, string[]>>;
  moodLines: Partial<Record<CompanionMood, CompanionLineTemplateSet>>;
  reactions: Partial<Record<CompanionReactionKey, string[]>>;
}

export interface CompanionPackSummary {
  id: string;
  displayName: string;
  archetype?: string;
  romanceMode: RomanceMode;
}

export interface CompanionSnapshot {
  mood: CompanionMood;
  frame: number;
  dueCount: number;
  recentWord: string | null;
  lineOverride?: string;
}

export interface CompanionTemplateContext {
  dueCount?: number;
  recentWord?: string | null;
  errorMessage?: string;
  reviewedCount?: number;
  gapDays?: number;
  todayReviewedCount?: number;
  capturedLast7Days?: number;
  reviewedLast7Days?: number;
  stableCount?: number;
  overdueDays?: number;
}

export interface CompanionStatusSignals {
  dueCount: number;
  recentWord: string | null;
}

export type CompanionEvent =
  | { type: "status_snapshot" }
  | { type: "planner_wait" }
  | { type: "study_wait" }
  | { type: "help" }
  | { type: "pet_ping" }
  | {
      type: "stats_summary";
      todayReviewedCount: number;
      dueCount: number;
      capturedLast7Days: number;
      reviewedLast7Days: number;
      stableCount: number;
    }
  | { type: "capture_success"; word: string }
  | { type: "ask_ready"; word: string }
  | { type: "teach_success"; word: string }
  | { type: "rescue_candidate"; word: string; overdueDays: number }
  | { type: "rescue_complete"; word: string }
  | { type: "return_after_gap"; reviewedCount: number; gapDays: number }
  | { type: "review_next"; word: string | null }
  | { type: "review_reveal"; word: string }
  | { type: "review_session_complete"; reviewedCount: number }
  | { type: "review_session_empty" }
  | { type: "review_session_paused"; reviewedCount: number }
  | { type: "review_session_quit"; reviewedCount: number }
  | { type: "command_error"; errorMessage?: string }
  | { type: "idle_prompt" }
  | { type: "shell_exit" };

export interface CompanionReactionResult {
  mood: CompanionMood;
  lineOverride?: string;
}
