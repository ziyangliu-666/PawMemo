import { ProviderRequestError } from "../lib/errors";

export type StructuredJsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function findBalancedJsonObjectEnd(
  input: string,
  startIndex: number
): number | null {
  if (input[startIndex] !== "{") {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index] ?? "";

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\") {
        escape = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }

      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      stack.push("}");
      continue;
    }

    if (char === "[") {
      stack.push("]");
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = stack.pop();

      if (expected !== char) {
        return null;
      }

      if (stack.length === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

function extractJsonCandidates(input: string): string[] {
  const candidates: string[] = [];

  for (let startIndex = 0; startIndex < input.length; startIndex += 1) {
    if (input[startIndex] !== "{") {
      continue;
    }

    const endIndex = findBalancedJsonObjectEnd(input, startIndex);

    if (endIndex === null) {
      continue;
    }

    candidates.push(input.slice(startIndex, endIndex));
  }

  return candidates;
}

function extractJsonCandidate(input: string): string {
  const sanitized = stripCodeFence(input);
  const candidates = extractJsonCandidates(sanitized);

  if (candidates.length > 0) {
    return candidates[0] ?? sanitized;
  }

  return sanitized;
}

export function parseStructuredJson(input: string): StructuredJsonObject;
export function parseStructuredJson<T>(
  input: string,
  validate: (value: StructuredJsonObject) => T
): T;
export function parseStructuredJson<T>(
  input: string,
  validate?: (value: StructuredJsonObject) => T
): StructuredJsonObject | T {
  const sanitized = stripCodeFence(input);
  const candidates = extractJsonCandidates(sanitized);
  const parseInputs = candidates.length > 0 ? candidates : [extractJsonCandidate(input)];
  let lastError: ProviderRequestError | null = null;

  for (const candidate of parseInputs) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown JSON parse error.";
      lastError = new ProviderRequestError(
        `Provider returned invalid JSON: ${message}`
      );
      continue;
    }

    if (!isRecord(parsed)) {
      lastError = new ProviderRequestError(
        "Provider returned JSON, but not a JSON object."
      );
      continue;
    }

    return validate ? validate(parsed) : parsed;
  }

  throw lastError ?? new ProviderRequestError("Provider returned invalid JSON.");
}
