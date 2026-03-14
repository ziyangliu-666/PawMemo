export function readRequestBody(body: RequestInit["body"]): string {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  return "";
}

export function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

export function createSseResponse(blocks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }

      controller.close();
    }
  });

  return new Response(body, {
    status,
    headers: {
      "content-type": "text/event-stream"
    }
  });
}
