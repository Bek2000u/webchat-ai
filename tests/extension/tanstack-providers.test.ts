import assert from "node:assert/strict";
import test from "node:test";
import { buildTextPrompt } from "../../src/extension/providers/text.js";
import { splitGoogleVidsScript } from "../../src/extension/providers/google-vids/audio.js";
import {
  createGoogleVidsTransport,
  PAGE_STATE_KEY,
} from "../../src/extension/providers/google-vids/transport.js";
import { type PageTab } from "../../src/extension/providers/google-vids/index.js";

test("plain browser text DTO builds the full prompt and schema without an LLM SDK", () => {
  const prompt = buildTextPrompt({
    model: "qwen-web",
    messages: [
      { role: "user", content: "First" },
      { role: "assistant", content: "Previous" },
      { role: "user", content: "Continue" },
    ],
    systemPrompts: ["Concise"],
    outputSchema: { type: "object", properties: { title: { type: "string" } } },
  });
  assert.match(prompt, /Concise/);
  assert.match(prompt, /\[assistant\]\nPrevious/);
  assert.match(prompt, /\[user\]\nContinue/);
  assert.match(prompt, /JSON Schema/);
  assert.match(prompt, /"title"/);
});

test("Google Vids keeps ordered native chunks without generation retry or a queue", () => {
  const text = "Sentence. ".repeat(800);
  const chunks = splitGoogleVidsScript(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2500));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), text.trim());
});
test("Google Vids rejected native execution is not retried or reloaded", async () => {
  const key = Symbol.for(PAGE_STATE_KEY),
    previous = Object.getOwnPropertyDescriptor(globalThis, key);
  let calls = 0,
    reloads = 0;
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      observerVersion: 5,
      transport: {},
      nativeXhrs: [{}],
      async execute() {
        calls++;
        return {
          ok: false,
          code: "GOOGLE_VIDS_ACCESS_DENIED",
          message: "Denied",
          submitted: false,
        };
      },
    },
  });
  const tab: PageTab = {
    async ensure() {
      reloads++;
    },
    execute(func, args) {
      return Promise.resolve(func(...args));
    },
  };
  try {
    await assert.rejects(
      createGoogleVidsTransport(tab).generate(
        { requestId: "vids-request", text: "Once", voice: "Schedar" },
        new AbortController().signal,
      ),
      /Denied/,
    );
    assert.equal(calls, 1);
    assert.equal(reloads, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else Reflect.deleteProperty(globalThis, key);
  }
});
