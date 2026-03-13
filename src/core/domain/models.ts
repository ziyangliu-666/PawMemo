export type MasteryState =
  | "unknown"
  | "seen"
  | "familiar"
  | "receptive"
  | "productive"
  | "stable";

export type ReviewCardState = "new" | "learning" | "review" | "relearning";

export type ReviewCardType = "recognition" | "cloze" | "usage" | "contrast";

export type ReviewGrade = "again" | "hard" | "good" | "easy";

export type LlmProviderName = "gemini" | "openai" | "anthropic";

export interface LlmModelInfo {
  id: string;
  provider: LlmProviderName;
  displayName: string | null;
  createdAt: string | null;
  ownedBy: string | null;
}

export interface LexemeRecord {
  id: number;
  lemma: string;
  normalized: string;
  createdAt: string;
  updatedAt: string;
}

export interface WordSenseRecord {
  id: number;
  lexemeId: number;
  senseKey: string;
  gloss: string;
  exampleContext: string;
  createdAt: string;
}

export interface WordEncounterRecord {
  id: number;
  lexemeId: number;
  contextText: string;
  sourceLabel: string | null;
  capturedAt: string;
}

export interface WordMasteryRecord {
  id: number;
  lexemeId: number;
  state: MasteryState;
  stability: number;
  difficulty: number;
  lastReviewedAt: string | null;
  nextDueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCardRecord {
  id: number;
  lexemeId: number;
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
  state: ReviewCardState;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DueReviewCard {
  id: number;
  lexemeId: number;
  lemma: string;
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
  state: ReviewCardState;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaptureWordInput {
  word: string;
  context: string;
  gloss: string;
  sourceLabel?: string;
  capturedAt?: string;
}

export interface CaptureWordResult {
  lexeme: LexemeRecord;
  sense: WordSenseRecord;
  encounter: WordEncounterRecord;
  mastery: WordMasteryRecord;
  cards: ReviewCardRecord[];
}

export interface ReviewQueueResult {
  items: DueReviewCard[];
  totalDue: number;
  dueReviewCount: number;
  dueNewCount: number;
  returnedCount: number;
}

export interface ReviewSessionSnapshot {
  items: DueReviewCard[];
  totalDue: number;
  dueReviewCount: number;
  dueNewCount: number;
}

export interface ReviewRevealResult {
  card: DueReviewCard;
}

export interface GetReviewQueueInput {
  now?: string;
  limit?: number;
}

export interface GradeReviewCardInput {
  cardId: number;
  grade: ReviewGrade;
  reviewedAt?: string;
}

export interface GradeReviewCardResult {
  card: DueReviewCard;
  mastery: WordMasteryRecord;
  grade: ReviewGrade;
  scheduledDays: number;
}

export interface RescueCandidateResult {
  card: DueReviewCard;
  overdueMinutes: number;
  overdueHours: number;
  overdueDays: number;
}

export interface AppSettingRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface LlmSettings {
  provider: LlmProviderName;
  model: string;
  apiKey: string | null;
  apiUrl: string | null;
}

export interface WordKnowledgeSnapshot {
  lexeme: LexemeRecord;
  sense: WordSenseRecord | null;
  mastery: WordMasteryRecord | null;
  recentEncounters: WordEncounterRecord[];
}

export interface AskWordInput {
  word: string;
  context: string;
  provider?: LlmProviderName;
  model?: string;
  apiKey?: string;
  apiUrl?: string;
}

export interface AskWordResult {
  word: string;
  normalized: string;
  gloss: string;
  explanation: string;
  usageNote: string;
  confidenceNote: string;
  provider: LlmProviderName;
  model: string;
  knownWord: boolean;
  knownState: MasteryState | null;
  retrievedGloss: string | null;
  recentContextCount: number;
}

export interface TeachWordInput extends AskWordInput {
  sourceLabel?: string;
}

export interface TeachWordResult {
  ask: AskWordResult;
  capture: CaptureWordResult;
}

export interface MasteryBreakdown {
  unknown: number;
  seen: number;
  familiar: number;
  receptive: number;
  productive: number;
  stable: number;
}

export interface StatsSummaryResult {
  generatedAt: string;
  todayReviewedCount: number;
  dueCount: number;
  dueReviewCount: number;
  dueNewCount: number;
  capturedLast7Days: number;
  reviewedLast7Days: number;
  masteryBreakdown: MasteryBreakdown;
}

export interface CompanionSignalsResult extends StatsSummaryResult {
  recentWord: string | null;
  stableCount: number;
  lastReviewedAt: string | null;
  hoursSinceLastReview: number | null;
  daysSinceLastReview: number | null;
}

export interface RecoveryProjectionResult {
  generatedAt: string;
  lastReviewedAt: string | null;
  hasPriorReviewHistory: boolean;
  isReturnAfterGap: boolean;
  returnGapDays: number | null;
  returnGapHours: number | null;
  daysSinceLastReview: number | null;
  rescueCandidate: RescueCandidateResult | null;
}

export type SuggestedNextAction = "rescue" | "review" | "capture";

export type HomeEntryKind =
  | "return_rescue"
  | "return_review"
  | "rescue"
  | "resume_recent"
  | "review"
  | "capture";

export type HomeFocusReason = "rescue" | "recent" | null;

export interface HomeProjectionResult {
  generatedAt: string;
  dueCount: number;
  recentWord: string | null;
  focusWord: string | null;
  focusReason: HomeFocusReason;
  hasPriorReviewHistory: boolean;
  isReturnAfterGap: boolean;
  returnGapDays: number | null;
  rescueCandidate: RescueCandidateResult | null;
  entryKind: HomeEntryKind;
  suggestedNextAction: SuggestedNextAction;
  canStopAfterPrimaryAction: boolean;
  optionalNextAction: SuggestedNextAction | null;
}
