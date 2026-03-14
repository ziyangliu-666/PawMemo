import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRequestError } from "../src/lib/errors";
import { AnthropicProvider } from "../src/llm/providers/anthropic-provider";
import {
  createJsonResponse,
  createSseResponse,
  readRequestBody
} from "./llm-provider-test-helpers";

test("AnthropicProvider uses custom apiUrl and required headers", async () => {
  const provider = new AnthropicProvider();
  const priorFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  let requestedBody = "";

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    requestedUrl = String(input);
    requestedHeaders = new Headers(init?.headers);
    requestedBody = readRequestBody(init?.body);

    return createJsonResponse({
      content: [
        {
          type: "text",
          text: "hello"
        }
      ]
    });
  }) as typeof fetch;

  try {
    const response = await provider.generateText({
      model: "claude-3-7-sonnet-latest",
      apiKey: "anthropic-key",
      apiUrl: "https://proxy.example/v1/",
      systemInstruction: "You are helpful.",
      userPrompt: "hello"
    });

    assert.equal(requestedUrl, "https://proxy.example/v1/messages");
    assert.equal(requestedHeaders.get("x-api-key"), "anthropic-key");
    assert.equal(requestedHeaders.get("anthropic-version"), "2023-06-01");
    assert.match(requestedBody, /"system":"You are helpful\."/, "system prompt missing");
    assert.match(requestedBody, /"messages":\[\{"role":"user","content":"hello"\}\]/);
    assert.equal(response.text, "hello");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("AnthropicProvider streams only content_block_delta events", async () => {
  const provider = new AnthropicProvider();
  const priorFetch = globalThis.fetch;
  const deltas: string[] = [];

  globalThis.fetch = (async () =>
    createSseResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"delta":{"text":"hel"}}\n\n',
      'event: ping\ndata: {"type":"ping"}\n\n',
      'event: content_block_delta\ndata: {"delta":{"text":"lo"}}\n\n',
      "data: [DONE]\n\n"
    ])) as typeof fetch;

  try {
    const response = await provider.generateTextStream({
      model: "claude-3-7-sonnet-latest",
      apiKey: "anthropic-key",
      systemInstruction: "Return plain text.",
      userPrompt: "hello",
      onTextDelta: async (delta) => {
        deltas.push(delta);
      }
    });

    assert.deepEqual(deltas, ["hel", "lo"]);
    assert.equal(response.text, "hello");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("AnthropicProvider paginates model listings with after_id", async () => {
  const provider = new AnthropicProvider();
  const priorFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL) => {
    requestedUrls.push(String(input));

    if (requestedUrls.length === 1) {
      return createJsonResponse({
        data: [
          {
            id: "claude-3-7-sonnet-latest",
            display_name: "Claude 3.7 Sonnet",
            created_at: "2026-01-01T00:00:00.000Z"
          }
        ],
        has_more: true,
        last_id: "cursor-1"
      });
    }

    return createJsonResponse({
      data: [
        {
          id: "claude-3-5-haiku-latest",
          display_name: "Claude 3.5 Haiku",
          created_at: "2025-10-01T00:00:00.000Z"
        }
      ],
      has_more: false
    });
  }) as typeof fetch;

  try {
    const models = await provider.listModels({
      apiKey: "anthropic-key",
      apiUrl: "https://proxy.example/v1/"
    });

    assert.equal(requestedUrls.length, 2);

    const firstUrl = new URL(requestedUrls[0]);
    const secondUrl = new URL(requestedUrls[1]);

    assert.equal(firstUrl.pathname, "/v1/models");
    assert.equal(firstUrl.searchParams.get("limit"), "100");
    assert.equal(firstUrl.searchParams.get("after_id"), null);
    assert.equal(secondUrl.searchParams.get("after_id"), "cursor-1");
    assert.deepEqual(
      models.map((model) => model.id),
      ["claude-3-5-haiku-latest", "claude-3-7-sonnet-latest"]
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("AnthropicProvider rejects empty text responses", async () => {
  const provider = new AnthropicProvider();
  const priorFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    createJsonResponse({
      content: [
        {
          type: "tool_use"
        }
      ]
    })) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        provider.generateText({
          model: "claude-3-7-sonnet-latest",
          apiKey: "anthropic-key",
          systemInstruction: "Return plain text.",
          userPrompt: "hello"
        }),
      (error: unknown) =>
        error instanceof ProviderRequestError &&
        error.message === "Anthropic returned an empty response."
    );
  } finally {
    globalThis.fetch = priorFetch;
  }
});
