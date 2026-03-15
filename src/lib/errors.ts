import type { DueReviewCard } from "../core/domain/models";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export class DuplicateEncounterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateEncounterError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class CardSelectionError extends Error {
  constructor(
    message: string,
    readonly selector: string,
    readonly candidates: DueReviewCard[] = []
  ) {
    super(message);
    this.name = "CardSelectionError";
  }
}

export class ReviewCardNotDueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewCardNotDueError";
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class ExplanationContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplanationContractError";
  }
}

export class CardAuthorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardAuthorContractError";
  }
}
