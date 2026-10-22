import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSDKRequest,
  requestRecordSchema,
  executeSchema,
  resultSchema,
  MODELS,
  PROVIDERS,
  VOICES,
} from "../../src/shared/contracts.js";

test("one shared native request validates all four modalities and rejects legacy envelopes", () => {
  for (const request of [
    {
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "Hello" }],
        systemPrompts: ["Concise"],
        outputSchema: { type: "object" },
      },
    },
    {
      kind: "image",
      options: { model: "nano-banana-2.1", prompt: "Image", size: "1k" },
    },
    {
      kind: "video",
      options: {
        model: "veo-3.1-fast-generate-preview",
        prompt: [
          { type: "text", content: "Video" },
          {
            type: "image",
            source: { type: "url", value: "data:image/png;base64,AA==" },
            metadata: { role: "start_frame" },
          },
        ],
        duration: 8,
      },
    },
    {
      kind: "audio",
      options: {
        model: "gemini-3.8-flash-tts",
        prompt: "Speech",
        modelOptions: { voice: "Schedar" },
      },
    },
  ])
    assert.deepEqual(parseSDKRequest(request), request);
  assert.throws(() =>
    parseSDKRequest({
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: [{ type: "image" }] }],
      },
    }),
  );
  assert.throws(() =>
    parseSDKRequest({
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "x" }],
        retry: { maxRetries: 3 },
      },
    }),
  );
  assert.throws(() =>
    executeSchema.parse({
      id: "one",
      request: {
        kind: "image",
        options: { model: "nano-banana-2.1", prompt: "x" },
      },
      attemptToken: "old",
    }),
  );
});
test("native structured primitives and completed request results survive the transport", () => {
  for (const result of [
    null,
    false,
    42,
    "plain",
    [1, 2],
    { text: "complete", chunks: [] },
  ])
    assert.deepEqual(resultSchema.parse({ id: "one", result }).result, result);
  const request = parseSDKRequest({
    kind: "audio",
    options: { model: "gemini-3.8-flash-tts", prompt: "x" },
  });
  assert.equal(
    requestRecordSchema.parse({
      id: "one",
      request,
      status: "completed",
      result: null,
      createdAt: "now",
      updatedAt: "now",
    }).result,
    null,
  );
});
test("central definitions retain all providers/models/voices while LLM is text only", () => {
  assert.equal(Object.keys(PROVIDERS).length, 6);
  assert.equal(MODELS.length, 13);
  assert.equal(VOICES.length, 30);
  assert.ok(
    MODELS.filter((m) => m.kind === "text").every((m) => m.maxReferences === 0),
  );
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});
