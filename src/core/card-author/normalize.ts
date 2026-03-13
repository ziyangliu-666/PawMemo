import type {
  AuthorStudyCardsResult,
  CardAuthorContext,
  CardAuthorPayload
} from "./types";

function sanitizePlainText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = value
    .replace(/```/g, " ")
    .replace(/[`*#>]/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();

  return sanitized.length > 0 ? sanitized : null;
}

function normalizeStatus(value: string | undefined): "ok" | "clarify" {
  return value?.trim().toLowerCase() === "clarify" ? "clarify" : "ok";
}

function countBlanks(value: string): number {
  return (value.match(/____/g) ?? []).length;
}

function normalizeContext(value: string | undefined): string | null {
  const sanitized = sanitizePlainText(value);

  if (!sanitized) {
    return null;
  }

  return sanitized.slice(0, 220).trim() || null;
}

function normalizeReason(value: string | undefined): string | null {
  const sanitized = sanitizePlainText(value);
  return sanitized ? sanitized.slice(0, 180).trim() || null : null;
}

export function normalizeCardAuthorOutput(
  context: CardAuthorContext,
  payload: CardAuthorPayload
): AuthorStudyCardsResult {
  const status = normalizeStatus(payload.status);
  const normalizedContext = normalizeContext(payload.normalized_context);
  const clozeContext = normalizeContext(payload.cloze_context);
  const reason = normalizeReason(payload.reason);

  if (status === "clarify") {
    return {
      word: context.word,
      normalized: context.normalized,
      gloss: context.gloss,
      provider: context.provider,
      model: context.model,
      accepted: false,
      reason: reason ?? "The study context needs clarification before PawMemo can save it.",
      normalizedContext: null,
      clozeContext: null
    };
  }

  if (!normalizedContext) {
    return {
      word: context.word,
      normalized: context.normalized,
      gloss: context.gloss,
      provider: context.provider,
      model: context.model,
      accepted: false,
      reason: "Provider did not return a usable normalized study context.",
      normalizedContext: null,
      clozeContext: null
    };
  }

  if (clozeContext && countBlanks(clozeContext) !== 1) {
    return {
      word: context.word,
      normalized: context.normalized,
      gloss: context.gloss,
      provider: context.provider,
      model: context.model,
      accepted: false,
      reason: "Provider returned a cloze context without exactly one blank.",
      normalizedContext: null,
      clozeContext: null
    };
  }

  return {
    word: context.word,
    normalized: context.normalized,
    gloss: context.gloss,
    provider: context.provider,
    model: context.model,
    accepted: true,
    reason: null,
    normalizedContext,
    clozeContext
  };
}
