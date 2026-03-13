export function normalizeApiUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/\/+$/, "");

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "")
    .replace(/\/models$/i, "");
}
