import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Server, type Socket as ServerSocket } from "socket.io";
import {
  BaseImageAdapter,
  BaseAudioAdapter,
  BaseVideoAdapter,
} from "@tanstack/ai/adapters";
import {
  BRIDGE_PATH,
  UPLOAD_PATH,
  type Execute,
  type Result,
  type ErrorEvent,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type Hello,
  type TextDTO,
} from "../../src/shared/contracts.js";
import {
  BrowserRuntime,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderTabLike,
  type SiteModelOptions,
  providerEnabled,
  setProviderEnabled,
} from "../../src/extension/runtime/runtime.js";

class MemoryStorage {
  data: Record<string, unknown> = {};
  async get(key: string) {
    return {
      [key]: key.startsWith("provider.enabled:") ? true : this.data[key],
    };
  }
  async set(value: Record<string, unknown>) {
    Object.assign(this.data, value);
  }
}
const tab: ProviderTabLike = {
  restore: async () => {},
  ensure: async () => 1,
  removed: async () => {},
  open: async () => 1,
  matches: () => true,
  async execute() {
    return undefined;
  },
};
test("Vids auto-check defaults on while explicit disable and other provider defaults are preserved", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const data: Record<string, unknown> = {};
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (value: Record<string, unknown>) => Object.assign(data, value),
  } } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "chrome", previous); else Reflect.deleteProperty(globalThis, "chrome"); });
  assert.equal(await providerEnabled("google_vids"), true);
  assert.equal(await providerEnabled("flow"), false);
  await setProviderEnabled("google_vids", false);
  assert.equal(await providerEnabled("google_vids"), false);
});
test("Vids registration preserves paid/free evidence and blocks credit profiles without affecting free text", async (t) => {
  let paid = false;
  let audioCalls = 0;
  const env = await environment(t, () => [{
    id: "google_vids", tab,
    detectAccount: async () => {
      if (!paid) throw Object.assign(Error("Unlimited paid account required"), {
        code: "GOOGLE_VIDS_PAID_PLAN_REQUIRED",
        account: { accountSubject: "owner@example.test", accountTier: "free" as const },
        details: { token: "private" },
      });
      return { accountSubject: "owner@example.test", accountTier: "paid" as const };
    },
    audio: () => { audioCalls++; throw Error("Must not execute"); },
  }, { ...textProvider("qwen_web", async () => ({ text: "ready" })),
    detectAccount: async () => ({ accountSubject: "owner@example.test", accountTier: "free" as const }),
  }]);
  const free = env.hello.at(-1)!.providers.find(p => p.id === "google_vids")!;
  assert.equal(free.available, false);
  assert.equal(free.accountTier, "free");
  assert.equal(free.accountSubject, "owner@example.test");
  assert.equal(free.error?.code, "GOOGLE_VIDS_PAID_PLAN_REQUIRED");
  assert.equal(JSON.stringify(free).includes("private"), false);
  assert.equal(env.hello.at(-1)!.providers.find(p => p.id === "qwen_web")?.available, true);
  env.send(0, { id: "credit-blocked", request: { kind: "audio", options: { model: "gemini-3.8-flash-tts", prompt: "Speech" } } });
  await until(() => env.errors.length === 1);
  assert.equal(env.errors[0].error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(audioCalls, 0);
  paid = true;
  await env.runtimes[0].publishProviders();
  await until(() => env.hello.at(-1)!.providers.some(p => p.id === "google_vids" && p.accountTier === "paid"));
  assert.equal(env.hello.at(-1)!.providers.find(p => p.id === "google_vids")?.available, true);
  paid = false;
  await env.runtimes[0].publishProviders();
  await until(() => env.hello.at(-1)!.providers.some(p => p.id === "google_vids" && p.accountTier === "free"));
  assert.equal(env.hello.at(-1)!.providers.find(p => p.id === "google_vids")?.available, false);
});
test("runtime sends the original UI code and stage through the common error adapter", async (t) => {
  const env = await environment(t, () => [
    textProvider("qwen_web", async () => {
      throw Object.assign(Error("New chat unavailable"), {
        code: "QWEN_UI_NOT_READY",
        stage: "new_chat",
        details: { token: "private" },
      });
    }),
  ]);
  env.send(0, {
    id: "ui-error",
    request: {
      kind: "text",
      options: {
        model: "qwen-web",
        messages: [{ role: "user", content: "Smoke" }],
      },
    },
  });
  await until(() => env.errors.length === 1);
  assert.deepEqual(env.errors[0].error, {
    code: "QWEN_UI_NOT_READY",
    message: "New chat unavailable",
    provider: "qwen_web",
    stage: "new_chat",
    outcome: "unknown",
    retryable: false,
  });
  assert.equal(env.results.length, 0);
});

test("targeted provider refresh preserves other statuses and publishes the full snapshot", async (t) => {
  const calls: string[] = [];
  let qwenSubject = "old@example.test";
  const env = await environment(t, () => ["qwen_web", "gemini_web", "google_vids"].map(id => ({
    id, tab,
    async detectAccount() { calls.push(id); return { accountSubject: id === "qwen_web" ? qwenSubject : "unchanged@example.test" }; },
  })));
  const runtime = env.runtimes[0];
  const previous = runtime.providers.find(provider => provider.id === "google_vids");
  calls.length = 0;
  qwenSubject = "new@example.test";
  await runtime.publishProviders("qwen_web");
  await until(() => env.hello.at(-1)!.providers.some(provider => provider.accountSubject === qwenSubject));
  assert.deepEqual(calls, ["qwen_web"]);
  assert.equal(runtime.providers.find(provider => provider.id === "google_vids"), previous);
  assert.equal(env.hello.at(-1)!.providers.length, 3);
  calls.length = 0;
  await runtime.refreshProviders("not-a-provider");
  assert.deepEqual(calls, []);
  assert.equal(runtime.providers.length, 3);
});

test("overlapping checks for different provider tabs do not overwrite newer statuses", async (t) => {
  let pending = false;
  let finish!: () => void;
  const env = await environment(t, () => ["qwen_web", "gemini_web"].map(id => ({
    id, tab,
    async detectAccount() {
      if (pending && id === "qwen_web") await new Promise<void>(resolve => { finish = resolve; });
      return { accountSubject: pending ? "updated@example.test" : "old@example.test" };
    },
  })));
  pending = true;
  const runtime = env.runtimes[0];
  const qwen = runtime.refreshProviders("qwen_web");
  await until(() => Boolean(finish));
  await runtime.refreshProviders("gemini_web");
  finish();
  await qwen;
  assert.equal(runtime.providers.length, 2);
  assert(runtime.providers.every(provider => provider.accountSubject === "updated@example.test"));
});
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function textProvider(
  id: string,
  generate: (
    options: TextDTO,
    context: ProviderContext,
  ) => Promise<{ text: string }>,
): ProviderAdapter {
  return {
    id,
    tab,
    detectAccount: async () => ({ accountSubject: "same@example.test" }),
    text: generate,
  };
}
async function environment(
  t: { after(fn: () => void | Promise<void>): void },
  factories: (index: number) => ProviderAdapter[],
  count = 1,
) {
  const storage = new MemoryStorage(),
    previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: storage } },
  });
  const server = createServer(),
    io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
      path: BRIDGE_PATH,
      transports: ["websocket"],
    });
  const profiles = new Map<
      string,
      ServerSocket<ClientToServerEvents, ServerToClientEvents>
    >(),
    hello: Hello[] = [],
    results: Result[] = [],
    errors: ErrorEvent[] = [],
    runtimes: BrowserRuntime[] = [];
  io.on("connection", (socket) => {
    socket.on("hello", (value) => {
      profiles.set(value.profileId, socket);
      hello.push(value);
    });
    socket.on("result", (value) => results.push(value));
    socket.on("error", (value) => {
      if ("id" in value) errors.push(value as unknown as ErrorEvent);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    for (const runtime of runtimes) runtime.disconnect();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  for (let index = 0; index < count; index++) {
    const runtime = new BrowserRuntime(factories(index), storage, {
      extensionVersion: "test",
    });
    runtime.settings = {
      profileId: crypto.randomUUID(),
      token: "paired",
      serverOrigin: origin,
    };
    runtimes.push(runtime);
    await runtime.connect();
  }
  await until(() => profiles.size === count);
  return {
    origin,
    runtimes,
    profiles,
    hello,
    results,
    errors,
    send(index: number, command: Execute) {
      profiles
        .get(runtimes[index].settings.profileId)!
        .emit("execute", command);
    },
  };
}
test("one direct execute produces native chat result; no legacy envelopes or local job store", async (t) => {
  let calls = 0;
  const env = await environment(t, () => [
    textProvider("gemini_web", async (options) => {
      calls++;
      assert.equal(options.messages[0].content, "SDK prompt");
      assert.deepEqual(options.systemPrompts, ["System"]);
      return { text: "answer" };
    }),
  ]);
  env.send(0, {
    id: "request-1",
    request: {
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "SDK prompt" }],
        systemPrompts: ["System"],
      },
    },
  });
  await until(() => env.results.length === 1);
  assert.equal(calls, 1);
  assert.equal(env.results[0].id, "request-1");
  assert.equal((env.results[0].result as { text: string }).text, "answer");
  assert.equal("chunks" in (env.results[0].result as object), false);
  assert.equal("state" in env.runtimes[0], false);
  assert.deepEqual(Object.keys(env.hello[0]).sort(), [
    "extensionVersion",
    "profileId",
    "providers",
    "token",
  ]);
});
test("structured request executes once and returns the actual chat data result", async (t) => {
  let calls = 0;
  const schema = {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  };
  const env = await environment(t, () => [
    textProvider("gemini_web", async (options) => {
      calls++;
      assert.deepEqual(options.outputSchema, schema);
      return { text: '{"title":"done"}' };
    }),
  ]);
  env.send(0, {
    id: "structured",
    request: {
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "Title" }],
        outputSchema: schema,
      },
    },
  });
  await until(() => env.results.length === 1 || env.errors.length > 0);
  assert.deepEqual(env.errors, []);
  assert.equal(calls, 1);
  assert.deepEqual(env.results[0].result, { text: '{"title":"done"}' });
});
test("invalid structured output is sent as an error before the server can mark it completed", async (t) => {
  let calls = 0;
  const env = await environment(t, () => [
    textProvider("gemini_web", async () => {
      calls++;
      return { text: "incomplete JSON" };
    }),
  ]);
  env.send(0, {
    id: "invalid-structured",
    request: {
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "JSON" }],
        outputSchema: { type: "object" },
      },
    },
  });
  await until(() => env.errors.length === 1);
  assert.equal(env.errors[0].error.code, "INVALID_STRUCTURED_OUTPUT");
  assert.equal(env.results.length, 0);
  assert.equal(calls, 1);
});

test("fresh attempts use distinct provider job identities but preserve the logical wire request ID", async (t) => {
  const operationIds: string[] = [];
  const env = await environment(t, () => [textProvider("gemini_web", async (_options, context) => {
    operationIds.push(context.requestId);
    return { text: "ok" };
  })]);
  for (const attempt of [1, 2]) {
    env.send(0, { id: "logical", attempt, request: { kind: "text", options: { model: "gemini-web", messages: [{ role: "user", content: "Smoke" }] } } });
    await until(() => env.results.length === attempt);
  }
  assert.deepEqual(operationIds, ["logical:attempt:1", "logical:attempt:2"]);
  assert.deepEqual(env.results.map(result => ({ id: result.id, attempt: result.attempt })), [{ id: "logical", attempt: 1 }, { id: "logical", attempt: 2 }]);
});

test("disconnect aborts local waiting and reconnect does not replay the request or emit stale result", async (t) => {
  let calls = 0,
    signal: AbortSignal | undefined,
    finish: (value: { text: string }) => void = () => {};
  const env = await environment(t, () => [
    textProvider("gemini_web", async (_options, context) => {
      calls++;
      signal = context.signal;
      return await new Promise((resolve) => {
        finish = resolve;
      });
    }),
  ]);
  env.send(0, {
    id: "lost",
    request: {
      kind: "text",
      options: {
        model: "gemini-web",
        messages: [{ role: "user", content: "Wait" }],
      },
    },
  });
  await until(() => calls === 1);
  env.profiles.get(env.runtimes[0].settings.profileId)!.disconnect(true);
  await until(() => signal!.aborted);
  assert.equal(env.runtimes[0].runningRequests.length, 0);
  await env.runtimes[0].connect();
  await until(() => env.hello.length === 2);
  finish({ text: "stale" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(env.results.length, 0);
  assert.equal(env.errors.length, 0);
});
test("same site account in two profiles executes in parallel, with one provider slot per profile", async (t) => {
  let calls = 0;
  const releases: (() => void)[] = [];
  const env = await environment(
    t,
    () => [
      textProvider("gemini_web", async () => {
        calls++;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { text: "done" };
      }),
    ],
    2,
  );
  const request = {
    kind: "text" as const,
    options: {
      model: "gemini-web",
      messages: [{ role: "user" as const, content: "Run" }],
    },
  };
  env.send(0, { id: "profile-1", request });
  env.send(1, { id: "profile-2", request });
  await until(() => calls === 2);
  env.send(0, { id: "busy", request });
  await until(() => env.errors.length === 1);
  assert.equal(env.errors[0].error.code, "PROVIDER_BUSY");
  releases.forEach((release) => release());
  await until(() => env.results.length === 2);
  assert.equal(calls, 2);
});
test("different provider slots in one profile run in parallel", async (t) => {
  let calls = 0;
  const releases: (() => void)[] = [];
  const env = await environment(t, () =>
    ["gemini_web", "qwen_web"].map((id) =>
      textProvider(id, async () => {
        calls++;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { text: "done" };
      }),
    ),
  );
  for (const [id, model] of [
    ["a", "gemini-web"],
    ["b", "qwen-web"],
  ])
    env.send(0, {
      id,
      request: {
        kind: "text",
        options: { model, messages: [{ role: "user", content: "Run" }] },
      },
    });
  await until(() => calls === 2);
  releases.forEach((release) => release());
  await until(() => env.results.length === 2);
});
test("disconnect during asynchronous connection setup does not open a late socket", async () => {
  const storage = new MemoryStorage(),
    previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let release: () => void = () => {},
    started = false,
    sockets = 0;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: storage } },
  });
  const provider = textProvider("gemini_web", async () => ({ text: "done" }));
  provider.detectAccount = async () => {
    started = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { accountSubject: "same@example.test" };
  };
  const runtime = new BrowserRuntime([provider], storage, {
    extensionVersion: "test",
    socketFactory: () => {
      sockets++;
      throw new Error("Socket must not open");
    },
  });
  runtime.settings = {
    profileId: crypto.randomUUID(),
    token: "paired",
    serverOrigin: "http://127.0.0.1:8000",
  };
  try {
    const pending = runtime.connect();
    await until(() => started);
    runtime.disconnect();
    release();
    await pending;
    assert.equal(sockets, 0);
    assert.equal(runtime.socket, null);
  } finally {
    runtime.disconnect();
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
test("all image batch files and audio/video results travel over HTTP and native SDK results contain URLs", async (t) => {
  const previous = globalThis.fetch,
    uploads: { headers: Headers; bytes: number }[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(String(input).endsWith(UPLOAD_PATH));
    const headers = new Headers(init?.headers);
    uploads.push({
      headers,
      bytes: (await new Response(init?.body).arrayBuffer()).byteLength,
    });
    return Response.json({
      id: String(uploads.length),
      url: "http://127.0.0.1:8000/files/" + uploads.length,
      mimeType: headers.get("Content-Type"),
      bytes: 1,
      sha256: "a".repeat(64),
    });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  class Image extends BaseImageAdapter<string, SiteModelOptions> {
    readonly name = "flow";
    async generateImages() {
      return {
        id: "images",
        model: this.model,
        images: [{ url: "fixture://first" }, { b64Json: "AQID" }],
      };
    }
  }
  class Audio extends BaseAudioAdapter<string, SiteModelOptions> {
    readonly name = "google_vids";
    async generateAudio() {
      return {
        id: "audio",
        model: this.model,
        audio: { url: "fixture://audio", contentType: "audio/wav" },
      };
    }
  }
  class Video extends BaseVideoAdapter<string, SiteModelOptions> {
    readonly name = "flow";
    async createVideoJob() {
      return { jobId: "video", model: this.model };
    }
    async getVideoStatus(jobId: string) {
      return { jobId, status: "completed" as const };
    }
    async getVideo(jobId: string) {
      return { jobId, url: "fixture://video" };
    }
  }
  const env = await environment(t, () => [
    {
      id: "flow",
      tab,
      detectAccount: async () => ({ accountSubject: "same@example.test" }),
      image: (model) => new Image(model),
      video: (model) => new Video({}, model),
      fetchArtifact: async () => ({
        body: new Blob([new Uint8Array([1, 2, 3])]),
        mimeType: "image/png",
      }),
    },
    {
      id: "google_vids",
      tab,
      detectAccount: async () => ({ accountSubject: "same@example.test" }),
      audio: (model) => new Audio(model),
      fetchArtifact: async () => ({
        body: new Blob([new Uint8Array([4, 5])]),
        mimeType: "audio/wav",
      }),
    },
  ]);
  env.send(0, {
    id: "image-batch",
    request: {
      kind: "image",
      options: {
        model: "gemini-3.0-pro-image",
        prompt: "Images",
        numberOfImages: 2,
      },
    },
  });
  await until(() => env.results.length === 1);
  env.send(0, {
    id: "video",
    request: {
      kind: "video",
      options: { model: "veo-3.1-fast-generate-preview", prompt: "Video" },
    },
  });
  await until(() => env.results.length === 2);
  env.send(0, {
    id: "audio",
    request: {
      kind: "audio",
      options: { model: "gemini-3.8-flash-tts", prompt: "Speech" },
    },
  });
  await until(() => env.results.length === 3);
  assert.equal(uploads.length, 4);
  assert.equal(
    (env.results[0].result as { images: unknown[] }).images.length,
    2,
  );
  assert.equal(JSON.stringify(env.results).includes("b64Json"), false);
  for (const upload of uploads) {
    assert.equal(upload.headers.get("Authorization"), "Bearer paired");
    assert.ok(upload.headers.get("X-Request-Id"));
    assert.ok(upload.headers.get("X-Profile-Id"));
    assert.equal(upload.headers.get("X-Attempt-Token"), null);
    assert.ok(upload.bytes > 0);
  }
});
