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
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.includes("timed out");
  }
  return false;
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
  let settled = false;

  const timeoutId = setTimeout(() => {
    if (!settled) {
      timedOut = true;
      const error = new Error(`${label} timed out.`);
      error.name = "AbortError";
      controller.abort(error);
    }
  }, timeoutMs);

  const clear = () => {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutId);
      upstreamSignal?.removeEventListener("abort", abortFromUpstream);
    }
  };

  const abortFromUpstream = () => {
    controller.abort(upstreamSignal?.reason);
    clear();
  };

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      abortFromUpstream();
    } else {
      upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
    }
  }

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal
    });

    if (!response.body) {
      clear();
      return response;
    }

    // Wrap the response to clear timeout only when body is consumed
    return new Proxy(response, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, target);

        if (typeof value === "function") {
          const bodyMethods = ["json", "text", "blob", "arrayBuffer", "formData"];
          if (bodyMethods.includes(prop as string)) {
            return async function (this: Response, ...args: any[]) {
              try {
                return await (value as Function).apply(target, args);
              } catch (error) {
                if (timedOut && isAbortError(error)) {
                  throw new ProviderRequestError(
                    `The ${label} timed out during body processing after ${formatTimeout(timeoutMs)}.`
                  );
                }
                throw error;
              } finally {
                clear();
              }
            };
          }
          return value.bind(target);
        }

        if (prop === "body" && value) {
          return wrapReadableStream(value as ReadableStream, clear, () => ({
            timedOut,
            timeoutMs,
            label
          }));
        }

        return value;
      }
    });
  } catch (error) {
    clear();
    if (timedOut && isAbortError(error)) {
      throw new ProviderRequestError(
        `The ${label} timed out after ${formatTimeout(timeoutMs)}.`
      );
    }

    throw error;
  }
}

function wrapReadableStream(
  stream: ReadableStream,
  onSettled: () => void,
  getTimeoutContext: () => { timedOut: boolean; timeoutMs: number; label: string }
): ReadableStream {
  const reader = stream.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) {
          onSettled();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        onSettled();
        const { timedOut, timeoutMs, label } = getTimeoutContext();
        if (timedOut && isAbortError(error)) {
          controller.error(
            new ProviderRequestError(
              `The ${label} timed out during streaming after ${formatTimeout(timeoutMs)}.`
            )
          );
        } else {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      onSettled();
      await reader.cancel(reason);
    }
  });
}
