import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRequestError } from "../src/lib/errors";
import { GeminiProvider } from "../src/llm/providers/gemini-provider";
import {
  createJsonResponse,
  createSseResponse,
  readRequestBody
} from "./llm-provider-test-helpers";

test("GeminiProvider uses custom apiUrl and default JSON response mime type", async () => {
  const provider = new GeminiProvider();
  const priorFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedBody = "";

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    requestedBody = readRequestBody(init?.body);

    return createJsonResponse({
      candidates: [
        {
          content: {
            parts: [{ text: '{"kind":"reply","message":"hi"}' }]
          }
        }
      ]
    });
  }) as typeof fetch;

  try {
    const response = await provider.generateText({
      model: "gemini-2.5-flash",
      apiKey: "gemini-key",
      apiUrl: "http://localhost:8080/v1beta/",
      systemInstruction: "Return JSON only.",
      userPrompt: "hello"
    });

    assert.equal(
      requestedUrl,
      "http://localhost:8080/v1beta/models/gemini-2.5-flash:generateContent"
    );
    assert.equal(requestedHeaders.get("authorization"), "Bearer gemini-key");
    assert.equal(requestedHeaders.get("x-goog-api-key"), "gemini-key");
    assert.match(requestedBody, /"responseMimeType":"application\/json"/);
    assert.equal(response.text, '{"kind":"reply","message":"hi"}');
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("GeminiProvider streams SSE deltas through onTextDelta", async () => {
  const provider = new GeminiProvider();
  const priorFetch = globalThis.fetch;
  let requestedUrl = "";
  const deltas: string[] = [];

  globalThis.fetch = (async (input: string | URL) => {
    requestedUrl = String(input);

    return createSseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"hel"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n'
    ]);
  }) as typeof fetch;

  try {
    const response = await provider.generateTextStream({
      model: "gemini-2.5-flash",
      apiKey: "gemini-key",
      apiUrl: "http://localhost:8080/v1beta",
      systemInstruction: "Return plain text.",
      userPrompt: "hello",
      onTextDelta: async (delta) => {
        deltas.push(delta);
      }
    });

    assert.equal(
      requestedUrl,
      "http://localhost:8080/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.equal(response.text, "hello");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("GeminiProvider rejects blocked prompts", async () => {
  const provider = new GeminiProvider();
  const priorFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    createJsonResponse({
      promptFeedback: {
        blockReason: "SAFETY"
      }
    })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        provider.generateText({
          model: "gemini-2.5-flash",
          apiKey: "gemini-key",
          systemInstruction: "Return JSON only.",
          userPrompt: "blocked"
        }),
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.message === "Gemini blocked the request: SAFETY."
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("GeminiProvider paginates model listings and filters unsupported models", async () => {
  const provider = new GeminiProvider();
  const priorFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL) => {
    requestedUrls.push(String(input));

    if (requestedUrls.length === 1) {
      return createJsonResponse({
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: ["generateContent"]
          },
          {
            name: "models/text-embedding-004",
            displayName: "Embedding",
            supportedGenerationMethods: ["embedContent"]
          }
        ],
        nextPageToken: "page-2"
      });
    }

    return createJsonResponse({
      models: [
        {
          name: "models/gemini-2.0-flash",
          displayName: "Gemini 2.0 Flash",
          supportedGenerationMethods: ["generateContent"]
        }
      ]
    });
  }) as typeof fetch;

  try {
    const models = await provider.listModels({
      apiKey: "gemini-key"
    });

    assert.equal(requestedUrls.length, 2);

    const firstUrl = new URL(requestedUrls[0]);
    const secondUrl = new URL(requestedUrls[1]);

    assert.equal(firstUrl.pathname, "/v1beta/models");
    assert.equal(firstUrl.searchParams.get("key"), "gemini-key");
    assert.equal(firstUrl.searchParams.get("pageToken"), null);
    assert.equal(secondUrl.searchParams.get("key"), "gemini-key");
    assert.equal(secondUrl.searchParams.get("pageToken"), "page-2");

    assert.deepEqual(
      models.map((model) => model.id),
      ["gemini-2.0-flash", "gemini-2.5-pro"]
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
