export type MasteryState =
  | "unknown"
  | "seen"
  | "familiar"
  | "receptive"
  | "productive"
  | "stable";

export type ReviewCardState = "new" | "learning" | "review" | "relearning";

export type ReviewCardType = "recognition" | "cloze" | "usage" | "contrast";

export type StudyCardLifecycleState = "active" | "paused" | "archived";

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

export interface StudyEntryRecord {
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

export interface StudyCardRecord {
  id: number;
  lexemeId: number;
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
  state: ReviewCardState;
  lifecycleState: StudyCardLifecycleState;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCardDraft {
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
}

export interface DueReviewCard {
  id: number;
  lexemeId: number;
  lemma: string;
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
  state: ReviewCardState;
  lifecycleState: StudyCardLifecycleState;
  dueAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudyCardSelector {
  cardId?: number;
  word?: string;
  cardType?: ReviewCardType;
}

export interface ListStudyCardsInput {
  word?: string;
  cardType?: ReviewCardType;
  lifecycleStates?: StudyCardLifecycleState[];
  limit?: number;
}

export interface ListStudyCardsResult {
  cards: DueReviewCard[];
}

export interface CreateStudyCardInput {
  word: string;
  cardType: ReviewCardType;
  promptText: string;
  answerText: string;
}

export interface UpdateStudyCardInput {
  selector: StudyCardSelector;
  promptText?: string;
  answerText?: string;
}

export interface SetStudyCardLifecycleInput {
  selector: StudyCardSelector;
  lifecycleState: StudyCardLifecycleState;
}

export interface DeleteStudyCardInput {
  selector: StudyCardSelector;
}

export type StudyCardOperationInput =
  | { kind: "list"; input: ListStudyCardsInput }
  | { kind: "create"; input: CreateStudyCardInput }
  | { kind: "update"; input: UpdateStudyCardInput }
  | { kind: "set-lifecycle"; input: SetStudyCardLifecycleInput }
  | { kind: "delete"; input: DeleteStudyCardInput };

export type StudyCardOperationResult =
  | {
      kind: "list";
      cards: DueReviewCard[];
    }
  | {
      kind: "create" | "update" | "set-lifecycle";
      card: DueReviewCard;
      previousLifecycleState: StudyCardLifecycleState | null;
    }
  | {
      kind: "delete";
      card: DueReviewCard;
    };

export interface CaptureWordInput {
  word: string;
  context: string;
  gloss: string;
  promptLanguage?: "en" | "zh";
  cardDraft?: {
    normalizedContext: string;
    clozeContext?: string | null;
    cardTypes?: ReviewCardType[];
  };
  sourceLabel?: string;
  capturedAt?: string;
}

export interface CaptureWordResult {
  lexeme: LexemeRecord;
  sense: WordSenseRecord;
  encounter: WordEncounterRecord;
  mastery: StudyEntryRecord;
  cards: StudyCardRecord[];
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
  mastery: StudyEntryRecord;
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
  mastery: StudyEntryRecord | null;
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
  example: string;
  highlights: string[];
  confidenceNote: string;
  responseLanguage: "en" | "zh";
  provider: LlmProviderName;
  model: string;
  knownWord: boolean;
  knownState: MasteryState | null;
  retrievedGloss: string | null;
  recentContextCount: number;
}

export type TeachStudyContextMode = "author" | "definition";

export interface TeachWordInput extends AskWordInput {
  sourceLabel?: string;
  studyContextMode?: TeachStudyContextMode;
}

export interface TeachCardDraft {
  word: string;
  gloss: string;
  promptLanguage: "en" | "zh";
  normalizedContext: string;
  clozeContext: string | null;
  cards: ReviewCardDraft[];
}

export interface TeachWordDraftResult {
  status: "ready";
  ask: AskWordResult;
  draft: TeachCardDraft;
}

export interface TeachWordDraftClarificationResult {
  status: "needs_clarification";
  ask: AskWordResult;
  promptLanguage: "en" | "zh";
  reason: string;
}

export type TeachWordDraftOutcome =
  | TeachWordDraftResult
  | TeachWordDraftClarificationResult;

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
