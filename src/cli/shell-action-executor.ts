import type {
  AppSettingRecord,
  AskWordInput,
  AskWordResult,
  CaptureWordInput,
  CaptureWordResult,
  CompanionSignalsResult,
  GetReviewQueueInput,
  GradeReviewCardInput,
  GradeReviewCardResult,
  HomeProjectionResult,
  LlmProviderName,
  RescueCandidateResult,
  ReviewQueueResult,
  ReviewRevealResult,
  TeachWordDraftResult,
  TeachWordInput,
  TeachWordResult
} from "../core/domain/models";
import { loadCompanionPack, listCompanionPacks } from "../companion/packs";
import { buildCompanionReaction } from "../companion/reaction-builder";
import type {
  CompanionEvent,
  CompanionPackDefinition,
  CompanionPackSummary,
  CompanionReactionResult,
  CompanionStatusSignals
} from "../companion/types";
import { hasAnyProviderEnvApiKey } from "../llm/provider-metadata";
import { StudyServices } from "../core/orchestration/study-services";
import type { LlmProvider } from "../llm/types";
import {
  LlmConfigService,
  type ListLlmModelsResult,
  type LlmStatusSummary
} from "../llm/llm-config-service";
import type { SqliteDatabase } from "../storage/sqlite/database";
import {
  createStudyReviewSessionServices,
  createDefaultReviewSessionTerminal,
  ReviewSessionRunner,
  type ReviewSessionCopy,
  type ReviewSessionRunOptions,
  type ReviewSessionRunResult,
  type ReviewSessionServices,
  type ReviewSessionTerminal
} from "./review-session-runner";
import {
  buildReturnAfterGapSummary,
  type ReturnAfterGapSummary
} from "./review-session-feedback";
import type { TeachPerfHook } from "../core/orchestration/teach-word";
import { AppSettingsRepository } from "../storage/repositories/app-settings-repository";
import { nowIso } from "../lib/time";

export interface ExecutedReviewSession {
  result: ReviewSessionRunResult;
  signalsBefore: CompanionSignalsResult;
  signalsAfter: CompanionSignalsResult;
  returnAfterGap: ReturnAfterGapSummary | null;
}

export interface ExecutedRescueSession {
  candidate: RescueCandidateResult;
  statusBefore: CompanionSignalsResult;
  home: HomeProjectionResult;
  result: ReviewSessionRunResult;
}

interface CompanionReactionOptions {
  at?: string;
  frame?: number;
  packId?: string;
  status?: CompanionStatusSignals;
}

export class ShellActionExecutor {
  private readonly study: StudyServices;
  private readonly llmConfig: LlmConfigService;
  private readonly settings: AppSettingsRepository;

  constructor(
    db: SqliteDatabase,
    providerFactory?: (name: LlmProviderName) => LlmProvider
  ) {
    this.study = new StudyServices(db, providerFactory);
    this.llmConfig = new LlmConfigService(db, providerFactory);
    this.settings = new AppSettingsRepository(db);
  }

  capture(input: CaptureWordInput): CaptureWordResult {
    return this.study.capture(input);
  }

  ask(
    input: AskWordInput,
    options: { signal?: AbortSignal } = {}
  ): Promise<AskWordResult> {
    return this.study.ask(input, options);
  }

  teach(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordResult> {
    return this.study.teach(input, perfHook, options);
  }

  draftTeach(
    input: TeachWordInput,
    perfHook?: TeachPerfHook,
    options: { signal?: AbortSignal } = {}
  ): Promise<TeachWordDraftResult> {
    return this.study.draftTeach(input, perfHook, options);
  }

  confirmTeachDraft(
    input: TeachWordInput,
    draft: TeachWordDraftResult,
    perfHook?: TeachPerfHook
  ): TeachWordResult {
    return this.study.confirmTeachDraft(input, draft, perfHook);
  }

  getReviewQueue(input: GetReviewQueueInput = {}): ReviewQueueResult {
    return this.study.getReviewQueue(input);
  }

  getNextReviewCard(now?: string) {
    return this.study.getNextReviewCard(now);
  }

  revealReviewCard(cardId: number): ReviewRevealResult {
    return this.study.revealReviewCard(cardId);
  }

  gradeReviewCard(input: GradeReviewCardInput): GradeReviewCardResult {
    return this.study.gradeReviewCard(input);
  }

  getCompanionSignals(at?: string): CompanionSignalsResult {
    return this.study.getCompanionSignals(at);
  }

  listSettings(): AppSettingRecord[] {
    return this.settings.list();
  }

  hasAnyUsableProviderApiKey(): boolean {
    return this.settings.hasAnyStoredApiKey() || hasAnyProviderEnvApiKey();
  }

  getActiveCompanionPack(packId?: string): CompanionPackDefinition {
    return loadCompanionPack(packId ?? this.settings.getCompanionPackId());
  }

  getActiveCompanionPackId(): string {
    return this.settings.getCompanionPackId();
  }

  listCompanionPacks(): CompanionPackSummary[] {
    return listCompanionPacks();
  }

  setActiveCompanionPack(packId: string): CompanionPackDefinition {
    const pack = loadCompanionPack(packId);
    this.settings.setCompanionPackId(pack.id, nowIso());
    return pack;
  }

  buildCompanionReaction(
    event: CompanionEvent,
    options: CompanionReactionOptions = {}
  ): CompanionReactionResult {
    const status = options.status ?? this.getCompanionSignals(options.at);

    return buildCompanionReaction(
      this.getActiveCompanionPack(options.packId),
      event,
      {
        dueCount: status.dueCount,
        recentWord: status.recentWord
      },
      options.frame ?? 0
    );
  }

  getHomeProjection(at?: string): HomeProjectionResult {
    return this.study.getHomeProjection(at);
  }

  getRecoveryProjection(at?: string) {
    return this.study.getRecoveryProjection(at);
  }

  getRescueCandidate(now?: string): RescueCandidateResult | null {
    return this.study.getRescueCandidate(now);
  }

  async runReviewSession(
    terminal: ReviewSessionTerminal,
    options: ReviewSessionRunOptions = {},
    copy?: ReviewSessionCopy
  ): Promise<ExecutedReviewSession> {
    const signalsBefore = this.study.getCompanionSignals(options.now);
    const result = await ReviewSessionRunner.withServices(
      createStudyReviewSessionServices(this.study),
      terminal,
      copy
    ).run(options);
    const signalsAfter = this.study.getCompanionSignals(options.now);

    return {
      result,
      signalsBefore,
      signalsAfter,
      returnAfterGap: buildReturnAfterGapSummary(
        signalsBefore,
        signalsAfter,
        result
      )
    };
  }

  runReviewSessionWithDefaultTerminal(
    options: ReviewSessionRunOptions = {},
    copy?: ReviewSessionCopy
  ): Promise<ExecutedReviewSession> {
    return this.runReviewSession(createDefaultReviewSessionTerminal(), options, copy);
  }

  async runRescueSession(
    terminal: ReviewSessionTerminal,
    options: { now?: string } = {},
    copy?: ReviewSessionCopy
  ): Promise<ExecutedRescueSession | null> {
    const candidate = this.study.getRescueCandidate(options.now);

    if (!candidate) {
      return null;
    }

    const statusBefore = this.study.getCompanionSignals(options.now);
    const home = this.study.getHomeProjection(options.now);
    let completed = false;
    const rescueServices: ReviewSessionServices = {
      getNext: () => (completed ? null : candidate.card),
      reveal: (cardId: number) => this.study.revealReviewCard(cardId),
      grade: (cardId, grade, reviewedAt) => {
        const result = this.study.gradeReviewCard({ cardId, grade, reviewedAt });
        completed = true;
        return result;
      }
    };

    const result = await ReviewSessionRunner.withServices(
      rescueServices,
      terminal,
      copy
    ).run({ now: options.now });

    return {
      candidate,
      statusBefore,
      home,
      result
    };
  }

  runRescueSessionWithDefaultTerminal(
    options: { now?: string } = {},
    copy?: ReviewSessionCopy
  ): Promise<ExecutedRescueSession | null> {
    return this.runRescueSession(
      createDefaultReviewSessionTerminal(),
      options,
      copy
    );
  }

  getLlmStatus(): LlmStatusSummary {
    return this.llmConfig.getStatusSummary();
  }

  getCurrentLlmSettings() {
    return this.llmConfig.getCurrentSettings();
  }

  listModels(options: {
    provider?: LlmProviderName;
    apiKey?: string;
    apiUrl?: string;
  }): Promise<ListLlmModelsResult> {
    return this.llmConfig.listModels(options);
  }

  updateCurrentLlmSettings(input: {
    provider: LlmProviderName;
    model?: string;
    apiKey?: string;
    apiUrl?: string;
  }): void {
    this.llmConfig.updateCurrentSettings(input);
  }

  setProviderApiUrl(provider: LlmProviderName, apiUrl: string): void {
    this.llmConfig.setProviderApiUrl(provider, apiUrl);
  }

  setProviderApiKey(provider: LlmProviderName, apiKey: string): void {
    this.llmConfig.setProviderApiKey(provider, apiKey);
  }
}
