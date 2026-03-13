import type {
  AskWordInput,
  AskWordResult,
  CaptureWordInput,
  CaptureWordResult,
  CompanionSignalsResult,
  DueReviewCard,
  GetReviewQueueInput,
  GradeReviewCardInput,
  GradeReviewCardResult,
  HomeProjectionResult,
  LlmProviderName,
  RecoveryProjectionResult,
  RescueCandidateResult,
  ReviewQueueResult,
  ReviewRevealResult,
  TeachWordDraftResult,
  TeachWordInput,
  TeachWordResult
} from "../domain/models";
import { createLlmProvider } from "../../llm/provider-factory";
import type { LlmProvider } from "../../llm/types";
import type { SqliteDatabase } from "../../storage/sqlite/database";
import { AskWordService } from "./ask-word";
import { CaptureWordService } from "./capture-word";
import { GetCompanionSignalsService } from "./get-companion-signals";
import { GetHomeProjectionService } from "./get-home-projection";
import { GetRecoveryProjectionService } from "./get-recovery-projection";
import { RescueService } from "./rescue-service";
import { ReviewService } from "./review-service";
import { TeachWordService } from "./teach-word";
import type { TeachPerfHook } from "./teach-word";

export class StudyServices {
  private readonly captureService: CaptureWordService;
  private readonly askService: AskWordService;
  private readonly teachService: TeachWordService;
  private readonly reviewService: ReviewService;
  private readonly rescueService: RescueService;
  private readonly companionSignalsService: GetCompanionSignalsService;
  private readonly recoveryProjectionService: GetRecoveryProjectionService;
  private readonly homeProjectionService: GetHomeProjectionService;

  constructor(
    db: SqliteDatabase,
    providerFactory: (name: LlmProviderName) => LlmProvider = createLlmProvider
  ) {
    this.captureService = new CaptureWordService(db);
    this.askService = new AskWordService(db, providerFactory);
    this.teachService = new TeachWordService(db, providerFactory);
    this.reviewService = new ReviewService(db);
    this.rescueService = new RescueService(db);
    this.companionSignalsService = new GetCompanionSignalsService(db);
    this.recoveryProjectionService = new GetRecoveryProjectionService(db);
    this.homeProjectionService = new GetHomeProjectionService(db);
  }

  capture(input: CaptureWordInput): CaptureWordResult {
    return this.captureService.capture(input);
  }

  ask(
    input: AskWordInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<AskWordResult> {
    return this.askService.ask(input, options);
  }

  teach(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordResult> {
    return this.teachService.teach(input, perfHook, options);
  }

  draftTeach(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordDraftResult> {
    return this.teachService.draft(input, perfHook, options);
  }

  confirmTeachDraft(
    input: TeachWordInput,
    draft: TeachWordDraftResult,
    perfHook?: TeachPerfHook
  ): TeachWordResult {
    return this.teachService.confirmDraft(input, draft, perfHook);
  }

  getReviewQueue(input: GetReviewQueueInput = {}): ReviewQueueResult {
    return this.reviewService.getQueue(input);
  }

  getNextReviewCard(now?: string): DueReviewCard | null {
    return this.reviewService.getNext(now);
  }

  revealReviewCard(cardId: number): ReviewRevealResult {
    return this.reviewService.reveal(cardId);
  }

  gradeReviewCard(input: GradeReviewCardInput): GradeReviewCardResult {
    return this.reviewService.grade(input);
  }

  getRescueCandidate(now?: string): RescueCandidateResult | null {
    return this.rescueService.getCandidate(now);
  }

  getCompanionSignals(at?: string): CompanionSignalsResult {
    return this.companionSignalsService.getSignals(at);
  }

  getRecoveryProjection(at?: string): RecoveryProjectionResult {
    return this.recoveryProjectionService.getProjection(at);
  }

  getHomeProjection(at?: string): HomeProjectionResult {
    return this.homeProjectionService.getProjection(at);
  }
}
