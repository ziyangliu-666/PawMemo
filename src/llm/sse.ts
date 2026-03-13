import { ProviderRequestError } from "../lib/errors";

export interface SseEvent {
  event: string | null;
  data: string;
}

function decodeSseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || null;
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n")
  };
}

export async function collectSseEvents(
  response: Response,
  onEvent: (event: SseEvent) => void | Promise<void>
): Promise<void> {
  const body = response.body;

  if (!body) {
    throw new ProviderRequestError("Provider returned an empty streaming body.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundary = buffer.search(/\r?\n\r?\n/);

      if (boundary < 0) {
        break;
      }

      const block = buffer.slice(0, boundary);
      const separatorMatch = /^\r?\n\r?\n/.exec(buffer.slice(boundary));
      const separatorLength = separatorMatch?.[0].length ?? 2;
      buffer = buffer.slice(boundary + separatorLength);

      const event = decodeSseBlock(block);

      if (event) {
        await onEvent(event);
      }
    }
  }

  const trailing = buffer.trim();

  if (trailing.length > 0) {
    const event = decodeSseBlock(trailing);

    if (event) {
      await onEvent(event);
    }
  }
}
