import type {
  MasteryState,
  ReviewCardState,
  ReviewGrade
} from "../core/domain/models";
import { addDays, addHours, addMinutes } from "../lib/time";

export interface ScheduleReviewInput {
  state: ReviewCardState;
  grade: ReviewGrade;
  reviewedAt: string;
  stability: number;
  difficulty: number;
}

export interface ScheduleReviewResult {
  nextState: ReviewCardState;
  dueAt: string;
  scheduledDays: number;
  stability: number;
  difficulty: number;
  masteryState: MasteryState;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function baseStability(grade: ReviewGrade): number {
  switch (grade) {
    case "again":
      return 0.2;
    case "hard":
      return 1;
    case "good":
      return 2;
    case "easy":
      return 4;
  }
}

function nextStability(stability: number, grade: ReviewGrade): number {
  if (stability <= 0) {
    return baseStability(grade);
  }

  switch (grade) {
    case "again":
      return Math.max(0.2, Number((stability * 0.5).toFixed(2)));
    case "hard":
      return Number((stability * 1.2).toFixed(2));
    case "good":
      return Number((stability * 2.0).toFixed(2));
    case "easy":
      return Number((stability * 3.0).toFixed(2));
  }
}

function nextDifficulty(difficulty: number, grade: ReviewGrade): number {
  const adjusted =
    grade === "again"
      ? difficulty + 0.2
      : grade === "hard"
        ? difficulty + 0.1
        : grade === "good"
          ? difficulty - 0.05
          : difficulty - 0.1;

  return Number(clamp(adjusted, 0, 1).toFixed(2));
}

function mapMasteryState(scheduledDays: number): MasteryState {
  if (scheduledDays < 1) {
    return "seen";
  }

  if (scheduledDays < 3) {
    return "familiar";
  }

  if (scheduledDays < 7) {
    return "receptive";
  }

  if (scheduledDays < 21) {
    return "productive";
  }

  return "stable";
}

function resolveIntervalDays(
  state: ReviewCardState,
  grade: ReviewGrade,
  stability: number
): number {
  switch (state) {
    case "new":
      return resolveNewInterval(grade);
    case "learning":
      return resolveLearningInterval(grade);
    case "review":
      return resolveReviewInterval(grade, stability);
    case "relearning":
      return resolveRelearningInterval(grade);
  }
}

function resolveNewInterval(grade: ReviewGrade): number {
  switch (grade) {
    case "again":
      return 10 / 1_440;
    case "hard":
      return 0.5;
    case "good":
      return 2;
    case "easy":
      return 4;
  }
}

function resolveLearningInterval(grade: ReviewGrade): number {
  switch (grade) {
    case "again":
      return 10 / 1_440;
    case "hard":
      return 1;
    case "good":
      return 3;
    case "easy":
      return 5;
  }
}

function resolveReviewInterval(grade: ReviewGrade, stability: number): number {
  switch (grade) {
    case "again":
      return 10 / 1_440;
    case "hard":
      return Math.max(2, Number((stability * 1.2).toFixed(2)));
    case "good":
      return Math.max(4, Number((stability * 2.0).toFixed(2)));
    case "easy":
      return Math.max(7, Number((stability * 3.0).toFixed(2)));
  }
}

function resolveRelearningInterval(grade: ReviewGrade): number {
  switch (grade) {
    case "again":
      return 10 / 1_440;
    case "hard":
      return 0.5;
    case "good":
      return 2;
    case "easy":
      return 4;
  }
}

function resolveNextState(
  state: ReviewCardState,
  grade: ReviewGrade
): ReviewCardState {
  switch (state) {
    case "new":
      return grade === "good" || grade === "easy" ? "review" : "learning";
    case "learning":
      return grade === "good" || grade === "easy" ? "review" : "learning";
    case "review":
      return grade === "again" ? "relearning" : "review";
    case "relearning":
      return grade === "good" || grade === "easy" ? "review" : "relearning";
  }
}

function resolveDueAt(reviewedAt: string, scheduledDays: number): string {
  if (scheduledDays < 1 / 24) {
    return addMinutes(reviewedAt, 10);
  }

  if (scheduledDays < 1) {
    return addHours(reviewedAt, scheduledDays * 24);
  }

  return addDays(reviewedAt, scheduledDays);
}

export function scheduleReview(input: ScheduleReviewInput): ScheduleReviewResult {
  const stability = nextStability(input.stability, input.grade);
  const difficulty = nextDifficulty(input.difficulty, input.grade);
  const scheduledDays = resolveIntervalDays(input.state, input.grade, stability);
  const nextState = resolveNextState(input.state, input.grade);
  const dueAt = resolveDueAt(input.reviewedAt, scheduledDays);

  return {
    nextState,
    dueAt,
    scheduledDays,
    stability,
    difficulty,
    masteryState: mapMasteryState(scheduledDays)
  };
}
