import { ProviderRequestError } from "../lib/errors";

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

function extractJsonCandidate(input: string): string {
  const sanitized = stripCodeFence(input);

  if (sanitized.startsWith("{") && sanitized.endsWith("}")) {
    return sanitized;
  }

  const start = sanitized.indexOf("{");
  const end = sanitized.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return sanitized.slice(start, end + 1);
  }

  return sanitized;
}

export function parseStructuredJson<T>(input: string): T {
  const candidate = extractJsonCandidate(input);
  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown JSON parse error.";
    throw new ProviderRequestError(`Provider returned invalid JSON: ${message}`);
  }

  if (!isRecord(parsed)) {
    throw new ProviderRequestError("Provider returned JSON, but not a JSON object.");
  }

  return parsed as T;
}
