import type { ExplainWordOutput, ExplanationContext, ExplanationPayload } from "./types";

const UNSUPPORTED_MEMORY_PATTERNS = [
  /\bI remember\b/i,
  /\bI still remember\b/i,
  /\bI know you\b/i,
  /\bI've seen you\b/i,
  /\bI saw you\b/i,
  /\bwe learned\b/i,
  /\bwe studied\b/i,
  /\bwith you\b/i
];

function sanitizePlainText(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = value
    .replace(/```/g, " ")
    .replace(/[`*_#>]/g, " ")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();

  return sanitized.length > 0 ? sanitized : null;
}

function splitSentences(value: string): string[] {
  const matches = value.match(/[^.!?]+[.!?]?/g) ?? [value];
  return matches.map((sentence) => sentence.trim()).filter(Boolean);
}

function removeUnsupportedMemoryClaims(value: string): string | null {
  const kept = splitSentences(value).filter(
    (sentence) =>
      !UNSUPPORTED_MEMORY_PATTERNS.some((pattern) => pattern.test(sentence))
  );

  if (kept.length === 0) {
    return null;
  }

  return kept.join(" ").trim();
}

function trimToLength(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }

  return value.slice(0, maxLength).trim() || null;
}

function normalizeTextField(
  value: string | undefined,
  fallback: string,
  maxLength: number
): string {
  const sanitized = sanitizePlainText(value);
  const stripped = sanitized ? removeUnsupportedMemoryClaims(sanitized) : null;
  return trimToLength(stripped, maxLength) ?? fallback;
}

function normalizeGlossField(value: string | undefined, maxLength: number): string | null {
  const sanitized = sanitizePlainText(value);

  if (!sanitized) {
    return null;
  }

  const firstLine = sanitized.split(/[.;!?]/, 1)[0]?.trim() ?? sanitized;
  const compact = firstLine.replace(/\s+/g, " ").trim();

  if (compact.length === 0) {
    return null;
  }

  return compact.slice(0, maxLength).trim() || null;
}

export function normalizeExplanationOutput(
  context: ExplanationContext,
  payload: ExplanationPayload
): ExplainWordOutput {
  const providerGloss = normalizeGlossField(payload.gloss, 120);
  const retrievedGloss = normalizeGlossField(context.knowledge?.sense?.gloss, 120);
  const gloss = providerGloss ?? retrievedGloss ?? "No gloss available.";
  const glossSource =
    providerGloss !== null
      ? "provider"
      : retrievedGloss !== null
        ? "retrieved"
        : "fallback";

  return {
    word: context.word,
    normalized: context.normalized,
    gloss,
    glossSource,
    providerGlossAccepted: providerGloss !== null,
    explanation: normalizeTextField(
      payload.explanation,
      "No explanation available.",
      280
    ),
    usageNote: normalizeTextField(
      payload.usage_note,
      "No usage note available.",
      180
    ),
    confidenceNote: normalizeTextField(
      payload.confidence_note,
      "This explanation depends on the provided context.",
      180
    ),
    provider: context.provider,
    model: context.model,
    knownWord: context.knowledge !== null,
    knownState: context.knowledge?.mastery?.state ?? null,
    retrievedGloss: context.knowledge?.sense?.gloss ?? null,
    recentContextCount: context.knowledge?.recentEncounters.length ?? 0
  };
}
