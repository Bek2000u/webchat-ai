import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText, generateImage, generateSpeech } from "ai";
import { chat } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { fixture } from "./fixture.js";
import { mediaSize } from "../../src/server/media.js";

for (const api of ["chat", "responses"] as const) {
  test("OpenAI SDK JSON + SSE: " + api, async () => {
    const f = await fixture();
    try {
      const sdk = new OpenAI(f.config);
      if (api === "chat") {
        const result = await sdk.chat.completions.create({
          model: "qwen-web",
          messages: [{ role: "user", content: "Hello" }],
        });
        assert.equal(result.choices[0].message.content, "SDK fixture answer");
        assert.equal(result.usage, null);
        const stream = await sdk.chat.completions.create({
          model: "qwen-web",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          stream_options: { include_usage: true },
        });
        let text = "";
        for await (const chunk of stream)
          text += chunk.choices[0]?.delta.content ?? "";
        assert.equal(text, "SDK fixture answer");
      } else {
        const result = await sdk.responses.create({
          model: "qwen-web",
          input: "Hello",
        });
        assert.equal(result.output_text, "SDK fixture answer");
        assert.equal(result.usage, null);
        const stream = await sdk.responses.create({
          model: "qwen-web",
          input: "Hello",
          stream: true,
        });
        let text = "",
          completed = false;
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") text += event.delta;
          if (event.type === "response.completed") completed = true;
        }
        assert.equal(text, "SDK fixture answer");
        assert.equal(completed, true);
      }
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  });

  test("Vercel generateText + streamText: " + api, async () => {
    const f = await fixture();
    try {
      const sdk = createOpenAI(f.config),
        model =
          api === "chat" ? sdk.chat("qwen-web") : sdk.responses("qwen-web");
      const result = await generateText({
        model,
        prompt: "Hello",
        maxRetries: 0,
      });
      assert.equal(result.text, "SDK fixture answer");
      const stream = streamText({ model, prompt: "Hello", maxRetries: 0 });
      let text = "";
      for await (const chunk of stream.textStream) text += chunk;
      assert.equal(text, "SDK fixture answer");
      assert.equal(await stream.finishReason, "stop");
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  });

  test("TanStack compatible chat and streaming: " + api, async () => {
    const f = await fixture();
    try {
      const adapter = openaiCompatibleText("qwen-web", {
        ...f.config,
        api: api === "chat" ? "chat-completions" : "responses",
      });
      const result = await chat({
        adapter,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      });
      assert.equal(result.text, "SDK fixture answer");
      const stream = chat({
        adapter,
        messages: [{ role: "user", content: "Hello" }],
      });
      let text = "";
      for await (const chunk of stream)
        if (chunk.type === "TEXT_MESSAGE_CONTENT") text += chunk.delta;
      assert.equal(text, "SDK fixture answer");
      assert.equal(f.calls.length, 2);
    } finally {
      await f.close();
    }
  });
}

test("reasoning modes reach one browser call; unsupported requests fail before Send", async () => {
  const f = await fixture(),
    sdk = new OpenAI(f.config);
  try {
    for (const [effort, mode] of [
      [undefined, "default"],
      ["low", "fast"],
      ["high", "deep"],
    ] as const) {
      await sdk.chat.completions.create({
        model: "gemini-web",
        messages: [{ role: "user", content: "Hi" }],
        reasoning_effort: effort,
      });
      assert.equal(f.calls.at(-1)?.options.modelOptions?.thinking, mode);
    }
    for (const body of [
      { temperature: 0.5 },
      {
        tools: [
          {
            type: "function",
            function: { name: "test", parameters: { type: "object" } },
          },
        ],
      },
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "https://invalid.test" } },
            ],
          },
        ],
      },
      { model: "missing-model" },
      { n: 2 },
    ]) {
      const response = await f.fetch(f.config.baseURL + "/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer contract-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen-web",
          messages: [{ role: "user", content: "Hi" }],
          ...body,
        }),
      });
      assert.ok([400, 404].includes(response.status));
      const error = await response.json();
      assert.equal(error.error.type, "invalid_request_error");
      assert.ok(response.headers.get("x-request-id"));
    }
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});

test("provider errors are HTTP failures, not assistant success, and OpenAI does not retry", async () => {
  const f = await fixture();
  f.execute(async () => {
    throw Object.assign(Error("Could not load response"), {
      code: "CHATGPT_RESPONSE_LOAD_FAILED",
    });
  });
  try {
    const sdk = new OpenAI({ ...f.config, maxRetries: 2 });
    await assert.rejects(
      sdk.chat.completions.create({
        model: "chatgpt-web",
        messages: [{ role: "user", content: "Hi" }],
      }),
      (error) => {
        assert.ok(error instanceof OpenAI.APIError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "CHATGPT_RESPONSE_LOAD_FAILED");
        return true;
      },
    );
    assert.equal(f.calls.length, 1);
    await assert.rejects(
      sdk.chat.completions.create({
        model: "chatgpt-web",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      }),
    );
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("JSON output uses one browser execution and rejects invalid JSON", async () => {
  const f = await fixture(),
    sdk = new OpenAI(f.config);
  try {
    f.execute(async (request) => {
      assert.equal(request.kind, "text");
      if (request.kind === "text") assert.ok(request.options.outputSchema);
      return { text: '{"ok":true}' };
    });
    const result = await sdk.chat.completions.create({
      model: "qwen-web",
      messages: [{ role: "user", content: "JSON" }],
      response_format: { type: "json_object" },
    });
    assert.deepEqual(JSON.parse(result.choices[0].message.content!), {
      ok: true,
    });
    assert.equal(f.calls.length, 1);
    const schema = await sdk.responses.create({
      model: "qwen-web",
      input: "JSON",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    });
    assert.deepEqual(JSON.parse(schema.output_text), { ok: true });
    f.execute(async () => ({ text: "Not JSON" }));
    await assert.rejects(
      sdk.chat.completions.create({
        model: "qwen-web",
        messages: [{ role: "user", content: "JSON" }],
        response_format: { type: "json_object" },
      }),
    );
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});

test("standard dimensions map to native media options without losing provider options", () => {
  assert.deepEqual(mediaSize("image", "1024x1024", { priority: "low" }), {
    size: "1k",
    modelOptions: { priority: "low", aspect: "square" },
  });
  assert.deepEqual(mediaSize("video", "1280x720"), {
    size: "720p",
    modelOptions: { aspect: "landscape" },
  });
  assert.deepEqual(mediaSize("video", "720x1280"), {
    size: "720p",
    modelOptions: { aspect: "portrait" },
  });
  assert.throws(() => mediaSize("video", "100x100"));
});

test("system/developer instructions retain message order across both API boundaries", async () => {
  const f = await fixture(),
    sdk = new OpenAI(f.config);
  try {
    await sdk.chat.completions.create({
      model: "qwen-web",
      messages: [
        { role: "user", content: "First" },
        { role: "developer", content: "Then instruction" },
        { role: "user", content: "Last" },
      ],
    });
    const request = f.calls[0];
    assert.equal(request.kind, "text");
    if (request.kind === "text")
      assert.deepEqual(request.options.messages, [
        { role: "user", content: "First" },
        { role: "system", content: "Then instruction" },
        { role: "user", content: "Last" },
      ]);
  } finally {
    await f.close();
  }
});

test("cancelling a client wait ends the journal without a second execution", async () => {
  const f = await fixture(),
    controller = new AbortController();
  f.execute(async () => new Promise(() => {}));
  try {
    const pending = f.fetch(f.config.baseURL + "/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer contract-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen-web",
        messages: [{ role: "user", content: "Wait" }],
      }),
    });
    while (!f.calls.length)
      await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const response = await pending;
    assert.equal(response.status, 499);
    assert.equal((await response.json()).error.code, "outcome_unknown");
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.listRequests()[0].error?.code, "outcome_unknown");
  } finally {
    await f.close();
  }
});

test("OpenAI media: image URL/base64, multipart edits, speech bytes/SSE, video status/content", async () => {
  const f = await fixture(),
    sdk = new OpenAI(f.config),
    bytes = new Uint8Array([1, 2, 3, 4]);
  f.execute(async (request, id) => {
    const mime =
      request.kind === "image"
        ? "image/png"
        : request.kind === "video"
          ? "video/mp4"
          : "audio/wav";
    const file = await f.files.put(
      new Response(bytes).body,
      id,
      mime,
      () => true,
    );
    const url = f.config.baseURL + "/files/" + file.id + "?token=fixture";
    if (request.kind === "image")
      return { id, model: request.options.model, images: [{ url }] };
    if (request.kind === "video") return { jobId: id, url, contentType: mime };
    return {
      id,
      model: request.options.model,
      audio: { url, contentType: mime },
    };
  });
  try {
    const image = await sdk.images.generate({
      model: "nano-banana-2.1",
      prompt: "Flower",
      response_format: "b64_json",
    });
    assert.equal(
      image.data![0].b64_json,
      Buffer.from(bytes).toString("base64"),
    );
    const edit = await sdk.images.edit({
      model: "nano-banana-2.1",
      prompt: "Flower",
      image: new File([bytes], "ref.png", { type: "image/png" }),
    });
    assert.ok(edit.data![0].url);
    assert.equal(f.calls[1].kind, "image");
    assert.ok(Array.isArray(f.calls[1].options.prompt));
    const audio = await sdk.audio.speech.create({
      model: "gemini-3.8-flash-tts",
      input: "Hello",
      voice: "Kore",
      response_format: "wav",
    });
    assert.equal(audio.headers.get("content-type"), "audio/wav");
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
    const speech = await f.fetch(f.config.baseURL + "/audio/speech", {
      method: "POST",
      headers: {
        Authorization: "Bearer contract-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gemini-3.8-flash-tts",
        input: "Hello",
        voice: "Kore",
        stream_format: "sse",
      }),
    });
    assert.match(await speech.text(), /speech.audio.done/);
    const job = await sdk.videos.create({
      model: "gemini-omni-flash-preview",
      prompt: "Move",
      seconds: "4",
      size: "1280x720",
    });
    await f.host.wait(job.id);
    assert.equal((await sdk.videos.retrieve(job.id)).status, "completed");
    assert.deepEqual(
      new Uint8Array(
        await (await sdk.videos.downloadContent(job.id)).arrayBuffer(),
      ),
      bytes,
    );
    assert.equal(f.calls.length, 5);
  } finally {
    await f.close();
  }
});

test("Vercel image/speech clients accept the same media endpoints", async () => {
  const f = await fixture(),
    sdk = createOpenAI(f.config),
    bytes = new Uint8Array([1, 2, 3]);
  f.execute(async (request, id) => {
    const audio = request.kind === "audio",
      mime = audio ? "audio/wav" : "image/png";
    const file = await f.files.put(
        new Response(bytes).body,
        id,
        mime,
        () => true,
      ),
      url = f.config.baseURL + "/files/" + file.id;
    return audio
      ? { id, model: request.options.model, audio: { url, contentType: mime } }
      : { id, model: request.options.model, images: [{ url }] };
  });
  try {
    const image = await generateImage({
      model: sdk.image("nano-banana-2.1"),
      prompt: "Flower",
      maxRetries: 0,
    });
    assert.deepEqual(image.image.uint8Array, bytes);
    const audio = await generateSpeech({
      model: sdk.speech("gemini-3.8-flash-tts"),
      text: "Hello",
      voice: "Kore",
      outputFormat: "wav",
      maxRetries: 0,
    });
    assert.deepEqual(audio.audio.uint8Array, bytes);
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});
