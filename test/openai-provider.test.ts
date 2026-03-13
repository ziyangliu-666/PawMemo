import test from "node:test";
import assert from "node:assert/strict";

import { OpenAiProvider } from "../src/llm/providers/openai-provider";

test("OpenAiProvider uses custom apiUrl for chat completions", async () => {
  const provider = new OpenAiProvider();
  const priorFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody = "";

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedBody =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : "";

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '{"kind":"reply","message":"hi"}'
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const response = await provider.generateText({
      model: "gemini-3-flash-preview",
      apiKey: "proxy-key",
      apiUrl: "http://172.24.160.1:7861/v1/",
      systemInstruction: "Return JSON only.",
      userPrompt: "hello",
      responseMimeType: "application/json"
    });

    assert.equal(requestedUrl, "http://172.24.160.1:7861/v1/chat/completions");
    assert.match(requestedBody, /"response_format":\{"type":"json_object"\}/);
    assert.equal(response.text, '{"kind":"reply","message":"hi"}');
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("OpenAiProvider uses custom apiUrl for model listing", async () => {
  const provider = new OpenAiProvider();
  const priorFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (input: string | URL) => {
    requestedUrl = String(input);

    return new Response(
      JSON.stringify({
        data: [
          {
            id: "gemini-3-flash-preview",
            owned_by: "gcli2api"
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const models = await provider.listModels({
      apiKey: "proxy-key",
      apiUrl: "http://172.24.160.1:7861/v1"
    });

    assert.equal(requestedUrl, "http://172.24.160.1:7861/v1/models");
    assert.equal(models[0]?.id, "gemini-3-flash-preview");
    assert.equal(models[0]?.ownedBy, "gcli2api");
  } finally {
    globalThis.fetch = priorFetch;
  }
});
