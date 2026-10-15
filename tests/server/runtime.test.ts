import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { io, type Socket } from "socket.io-client";
import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { chat } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { BRIDGE_PATH, type Execute } from "../../src/shared/contracts.js";
import { startApi } from "../../src/server/index.js";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "b2a-server-")),
    old = join(dir, "browser2api.sqlite3");
  await writeFile(old, "unchanged legacy database sentinel");
  const instance = await startApi({
    DATA_DIR: dir,
    HOST: "127.0.0.1",
    PORT: "0",
    EXTENSION_ORIGINS: origin,
    BOOTSTRAP_API_KEY: "fixture-api-key",
  });
  if (!instance.server.listening) await once(instance.server, "listening");
  const address = instance.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`,
    sockets: Socket[] = [];
  async function profile(id = randomUUID(), token = "fixture-" + randomUUID()) {
    const socket = io(base, {
      path: BRIDGE_PATH,
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { Origin: origin },
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    socket.emit("hello", {
      profileId: id,
      token,
      extensionVersion: "fixture",
      providers: [
        { id: "qwen_web", available: true },
        { id: "google_vids", available: true, accountTier: "paid" },
      ],
    });
    await until(() => instance.host.connectedIds().has(id));
    return { id, token, socket };
  }
  return {
    ...instance,
    dir,
    base,
    profile,
    client: new OpenAI({
      baseURL: base + "/v1",
      apiKey: "fixture-api-key",
      maxRetries: 0,
    }),
    async cleanup() {
      for (const socket of sockets) socket.disconnect();
      await instance.close();
      assert.equal(
        await readFile(old, "utf8"),
        "unchanged legacy database sentinel",
      );
      await access(join(dir, "app.sqlite3"));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("repeated hello updates Chrome email on the same profile without merging equal emails", async () => {
  const f = await runtime();
  try {
    const first = await f.profile();
    const second = await f.profile();
    const hello = (profile: typeof first, email: string) => profile.socket.emit("hello", {
      profileId: profile.id, token: profile.token, extensionVersion: "identity-fixture",
      browserIdentity: { email, id: "private-id" },
      providers: [{ id: "qwen_web", available: true, accountSubject: "website@example.com" }],
    });
    hello(first, " Chrome@Example.com "); hello(second, "chrome@example.com");
    await until(() => f.store.getProfile(first.id)?.browserIdentity?.email === "chrome@example.com" && f.store.getProfile(second.id)?.browserIdentity?.email === "chrome@example.com");
    assert.equal(f.store.listProfiles().length, 2);
    hello(first, "changed@example.com");
    await until(() => f.store.getProfile(first.id)?.browserIdentity?.email === "changed@example.com");
    assert.equal(f.store.listProfiles().length, 2);
    assert(f.store.authenticateProfile(first.id, first.token));
    assert.equal(f.store.getProfile(first.id)?.providers[0].accountSubject, "website@example.com");
  } finally { await f.cleanup(); }
});

test("client to real Hono and Socket.IO executes one text request and returns native SDK chunks", async () => {
  const f = await runtime();
  try {
    const profile = await f.profile();
    let executed = 0;
    profile.socket.on("execute", (value: Execute) => {
      executed++;
      assert.equal(value.request.kind, "text");
      profile.socket.emit("result", {
        id: value.id,
        result: {
          text: "Fixture Chrome answer",
          chunks: [
            {
              type: "TEXT_MESSAGE_START",
              messageId: "chrome-message",
              role: "assistant",
              timestamp: 1,
            },
            {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "chrome-message",
              delta: "Fixture Chrome answer",
              timestamp: 2,
            },
            {
              type: "TEXT_MESSAGE_END",
              messageId: "chrome-message",
              timestamp: 3,
            },
            {
              type: "RUN_FINISHED",
              threadId: "chrome-thread",
              runId: "chrome-run",
              timestamp: 4,
            },
          ],
        },
      });
    });
    const result = await f.client.chat.completions.create({
      model: "qwen-web",
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    });
    assert.equal(result.choices[0].message.content, "Fixture Chrome answer");
    assert.equal(executed, 1);
    assert.equal(f.store.listRequests()[0]?.status, "completed");
  } finally {
    await f.cleanup();
  }
});
test("profile disconnect returns outcome_unknown and reconnect does not execute it again", async () => {
  const f = await runtime();
  try {
    const profile = await f.profile();
    let executed = 0;
    profile.socket.on("execute", () => {
      executed++;
      profile.socket.disconnect();
    });
    await assert.rejects(
      f.client.chat.completions.create({
        model: "qwen-web",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      }),
      (error) => {
        assert.match(String(error), /disconnected|unknown/i);
        return true;
      },
    );
    assert.equal(f.store.listRequests()[0]?.error?.code, "outcome_unknown");
    await f.profile(profile.id, profile.token);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executed, 1);
    assert.equal(f.store.listRequests().length, 1);
  } finally {
    await f.cleanup();
  }
});
test("native file upload checks active profile request and signed download supports ranges", async () => {
  const f = await runtime();
  try {
    const profile = await f.profile();
    let executed = 0;
    const completed = new Promise<void>((resolve, reject) =>
      profile.socket.on("execute", (value: Execute) => {
        void (async () => {
          executed++;
          assert.equal(value.request.kind, "audio");
          const upload = await fetch(f.base + "/api/browser/files", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + profile.token,
              "X-Profile-Id": profile.id,
              "X-Request-Id": value.id,
              "Content-Type": "audio/wav",
            },
            body: new Uint8Array([0, 1, 2, 3, 4]),
          });
          assert.equal(upload.status, 201);
          const file = (await upload.json()) as { id: string; url: string };
          assert.equal("path" in file, false);
          const ranged = await fetch(file.url, {
            headers: { Range: "bytes=1-3" },
          });
          assert.equal(ranged.status, 206);
          assert.equal(ranged.headers.get("content-range"), "bytes 1-3/5");
          assert.deepEqual(
            new Uint8Array(await ranged.arrayBuffer()),
            new Uint8Array([1, 2, 3]),
          );
          assert.equal(
            (await fetch(file.url.replace("token=", "token=invalid"))).status,
            403,
          );
          profile.socket.emit("result", {
            id: value.id,
            result: {
              id: value.id,
              model: value.request.options.model,
              audio: { url: file.url, contentType: "audio/wav" },
            },
          });
          resolve();
        })().catch(reject);
      }),
    );
    const audio = await f.client.audio.speech.create({
      model: "gemini-3.8-flash-tts",
      input: "Hello",
      voice: "Kore",
      response_format: "wav",
    });
    await completed;
    assert.equal(executed, 1);
    assert.deepEqual(
      new Uint8Array(await audio.arrayBuffer()),
      new Uint8Array([0, 1, 2, 3, 4]),
    );
    const record = f.store.listRequests()[0]!;
    assert.equal(audio.headers.get("x-request-id"), record.id);
    const late = await fetch(f.base + "/api/browser/files", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + profile.token,
        "X-Profile-Id": profile.id,
        "X-Request-Id": record.id,
        "Content-Type": "audio/wav",
      },
      body: new Uint8Array([5]),
    });
    assert.equal(late.status, 403);
  } finally {
    await f.cleanup();
  }
});

test("Chrome terminal error reaches the client once without retry", async () => {
  const f = await runtime();
  try {
    const profile = await f.profile();
    let executed = 0;
    profile.socket.on("execute", (value: Execute) => {
      executed++;
      profile.socket.emit("error", {
        id: value.id,
        error: { code: "provider_failed", message: "Fixture provider error" },
      });
    });
    await assert.rejects(
      f.client.audio.speech.create({
        model: "gemini-3.8-flash-tts",
        input: "Hello",
        voice: "Kore",
        response_format: "wav",
      }),
      (error) => {
        assert.ok(error instanceof OpenAI.APIError);
        assert.equal(error.code, "provider_failed");
        return true;
      },
    );
    assert.equal(executed, 1);
    assert.equal(f.store.listRequests()[0]?.status, "error");
  } finally {
    await f.cleanup();
  }
});

for (const client of ["openai", "vercel", "tanstack"] as const) for (const api of ["chat", "responses"] as const)
  test(`${client}/${api}: real HTTP and sockets route auto with one bounded fallback`, async () => {
    const f = await runtime();
    try {
      const a = await f.profile(), b = await f.profile();
      let calls = 0;
      a.socket.on("execute", (value: Execute) => {
        calls++;
        assert.equal(value.request.options.model, "qwen-web");
        a.socket.emit("error", { id: value.id, attempt: value.attempt, error: { code: "QWEN_RESPONSE_TIMEOUT", message: "The response could not be read", outcome: "unknown", retryable: true, stage: "response" } });
      });
      b.socket.on("execute", (value: Execute) => {
        calls++;
        assert.equal(value.attempt, 2);
        assert.equal(value.request.options.model, "qwen-web");
        b.socket.emit("result", { id: value.id, attempt: value.attempt, result: { text: "Fallback answer" } });
      });
      const config = { baseURL: f.base + "/v1", apiKey: "fixture-api-key", maxRetries: 0 };
      let text: string;
      if (client === "openai") {
        const sdk = new OpenAI(config);
        text = api === "chat"
          ? (await sdk.chat.completions.create({ model: "auto", messages: [{ role: "user", content: "Hello" }] })).choices[0].message.content!
          : (await sdk.responses.create({ model: "auto", input: "Hello" })).output_text;
      } else if (client === "vercel") {
        const sdk = createOpenAI(config);
        text = (await generateText({ model: api === "chat" ? sdk.chat("auto") : sdk.responses("auto"), prompt: "Hello", maxRetries: 0 })).text;
      } else {
        text = (await chat({ adapter: openaiCompatibleText("auto", { ...config, api: api === "chat" ? "chat-completions" : "responses" }), messages: [{ role: "user", content: "Hello" }], stream: false })).text;
      }
      assert.equal(text, "Fallback answer");
      assert.equal(calls, 2);
      const records = f.store.listRequests();
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].attempts.map(a => a.decision), ["retry", "completed"]);
    } finally { await f.cleanup(); }
  });

test("client error is bounded, actionable and correlated to the same request and attempts", async () => {
  const f = await runtime();
  try {
    const a = await f.profile();
    let calls = 0;
    a.socket.on("execute", (value: Execute) => {
      calls++;
      a.socket.emit("error", { id: value.id, attempt: value.attempt, error: {
        code: "QWEN_THINKING_UNAVAILABLE", message: "This account cannot enable Deep thinking. Choose another profile or default mode.",
        provider: "qwen_web", stage: "thinking", outcome: "not_submitted", retryable: true,
      } });
    });
    const response = await fetch(f.base + "/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer fixture-api-key", "Content-Type": "application/json" }, body: JSON.stringify({ model: "qwen-web", messages: [{ role: "user", content: "Hi" }], reasoning_effort: "high" }) });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, "QWEN_THINKING_UNAVAILABLE");
    assert.equal(error.provider, "qwen_web");
    assert.equal(error.stage, "thinking");
    assert.equal(error.retryable, true);
    assert.equal(error.outcome, "not_submitted");
    assert.equal(error.request_id, f.store.listRequests()[0].id);
    assert.equal(response.headers.get("x-request-id"), error.request_id);
    assert.equal(response.headers.get("x-should-retry"), "false");
    assert.equal(error.attempts.length, 1);
    assert.match(error.message, /Choose another profile/);
    assert.equal(calls, 1);
    assert.equal(f.store.listProfiles()[0].enabled, true);
  } finally { await f.cleanup(); }
});
