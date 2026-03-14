import test from "node:test";
import assert from "node:assert/strict";

import { parseStructuredJson } from "../src/llm/structured-output";

test("parseStructuredJson finds the right JSON object inside surrounding text", () => {
  const payload = parseStructuredJson(
    'Here is {not json} and then {"kind":"reply","message":"hi","tags":["a","b"]} thanks {wave}'
  );

  assert.deepEqual(payload, {
    kind: "reply",
    message: "hi",
    tags: ["a", "b"]
  });
});

test("parseStructuredJson can validate and coerce provider payloads", () => {
  const payload = parseStructuredJson(
    '{"gloss":"emit light","highlights":["bright","glow"],"ignored":42}',
    (value) => ({
      gloss: typeof value.gloss === "string" ? value.gloss : undefined,
      highlights: Array.isArray(value.highlights)
        ? value.highlights.filter((item): item is string => typeof item === "string")
        : []
    })
  );

  assert.deepEqual(payload, {
    gloss: "emit light",
    highlights: ["bright", "glow"]
  });
});
