import type { LlmProviderName } from "../core/domain/models";
import { isLlmProviderName } from "../llm/provider-factory";
import { UsageError } from "../lib/errors";

export function asProviderName(
  value: string | undefined
): LlmProviderName | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isLlmProviderName(value)) {
    throw new UsageError(`Unsupported provider: ${value}`);
  }

  return value;
}

export function parseHighlightPercent(rawValue: string | undefined): number {
  const value = Number.parseFloat(rawValue ?? "");

  if (!Number.isFinite(value) || value <= 0 || value > 100) {
    throw new UsageError("`/highlight` requires a percent between 0 and 100.");
  }

  return value;
}

export function parseHighlightTotalChars(rawValue: string | undefined): number {
  const value = Number.parseInt(rawValue ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError("`/highlight` requires a positive total character count.");
  }

  return value;
}
