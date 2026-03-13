import { ProviderRequestError } from "../lib/errors";

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;

function resolveTimeoutMs(): number {
  const rawValue = process.env.PAWMEMO_LLM_TIMEOUT_MS?.trim();

  if (!rawValue) {
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }

  return parsed;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs % 1000 === 0) {
    return `${timeoutMs / 1000}s`;
  }

  return `${timeoutMs}ms`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export async function fetchWithLlmTimeout(
  input: string | URL,
  init: RequestInit,
  label: string
): Promise<Response> {
  const timeoutMs = resolveTimeoutMs();
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  let timedOut = false;

  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${label} timed out.`));
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new ProviderRequestError(
        `The ${label} timed out after ${formatTimeout(timeoutMs)}.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
