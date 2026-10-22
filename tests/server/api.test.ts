import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MODELS, type SDKRequest } from "../../src/shared/contracts.js";
import { createApp, type ApiConfig } from "../../src/server/api.js";
import { ApiStore } from "../../src/server/storage.js";
import { BrowserDispatcher } from "../../src/server/runtime.js";
import { FileStore } from "../../src/server/files.js";

async function fixture(overrides: Partial<ApiConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "b2a-api-")),
    store = await ApiStore.open({ path: ":memory:" }),
    host = new BrowserDispatcher(store, [
      "chrome-extension://pnamggpmjbeoohafaokfcjhpdmijmmda",
    ]),
    files = new FileStore(store.db, join(dir, "files"));
  const app = createApp({
    store,
    host,
    files,
    config: {
      dataDir: dir,
      webDir: join(dir, "web"),
      bootstrapApiKey: "fixture-api-key",
      fileSecret: "fixture-file-secret",
      ...overrides,
    },
  });
  const apiHeaders = {
    Authorization: "Bearer fixture-api-key",
    "Content-Type": "application/json",
  };
  const uiHeaders = {
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
  };
  return {
    dir,
    store,
    host,
    files,
    app,
    apiHeaders,
    uiHeaders,
    async close() {
      await host.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const text: SDKRequest = {
  kind: "text",
  options: {
    model: "qwen-web",
    messages: [{ role: "user", content: "Hello" }],
    modelOptions: { search: true },
  },
};
test("UI keeps Chrome identity separate from site identity and exposes bounded connection errors without credentials", async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    f.store.createProfile(id, "never-expose-this-token", "Рабочий Chrome");
    f.store.registerProfile(id, "fixture", [{ id: "qwen_web", available: false, accountSubject: "website@example.com", accountTier: "free", error: { code: "LOGIN_REQUIRED", message: "Войдите на сайт", stage: "account", provider: "qwen_web" } }], { email: "chrome@example.com", id: "private-gaia-id" });
    const rows = await (await f.app.request("/api/accounts", { headers: f.uiHeaders })).json();
    assert.equal(rows[0].chrome_email, "chrome@example.com");
    assert.equal(rows[0].label, "Рабочий Chrome");
    assert.equal(rows[0].providers[0].account_subject, "website@example.com");
    assert.equal(rows[0].providers[0].connection_error.stage, "account");
    const serialized = JSON.stringify(rows);
    for (const secret of ["never-expose-this-token", "private-gaia-id", "tokenHash", "account_email"]) assert(!serialized.includes(secret));
    assert.deepEqual(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ["api_keys", "files", "profiles", "requests"]);
  } finally { await f.close(); }
});

test("provider queue is counted globally once, with auto separate from profiles", async () => {
  const f = await fixture();
  try {
    f.store.createProfile("one", "one"); f.store.createProfile("two", "two");
    for (let index = 0; index < 105; index++) f.store.createRequest(text);
    f.store.createRequest({ ...text, options: { ...text.options, model: "auto" } });
    const stats = await (await f.app.request("/api/stats", { headers: f.uiHeaders })).json();
    assert.deepEqual(stats.queue, { providers: { qwen_web: 105 }, auto: 1 });
  } finally { await f.close(); }
});
test("OpenAI catalog is authenticated and the old request API is removed", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.request("/v1/models")).status, 401);
    for (const path of [
      "/v1/requests",
      "/v1/requests/missing",
      "/v1/requests/missing/cancel",
      "/v1/generations",
    ]) {
      const response = await f.app.request(path, {
        method: path.endsWith("missing") ? "GET" : "POST",
        headers: f.apiHeaders,
        body: path.endsWith("missing") ? undefined : "{}",
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error.type, "invalid_request_error");
    }
    const models = await (
      await f.app.request("/v1/models", { headers: f.apiHeaders })
    ).json();
    assert.equal(models.data.length, MODELS.length);
    assert.equal(models.data[0].object, "model");
    assert.equal(typeof models.data[0].owned_by, "string");
    const speech = models.data.find((model: { id: string }) => model.id === "gemini-3.8-flash-tts");
    assert.ok(speech);
    assert.equal(speech.label, "Gemini 3.8 Flash TTS");
    assert.equal(speech.owned_by, "google");
    assert.equal("providerId" in speech, false);
    assert.equal(JSON.stringify(speech).includes("google_vids"), false);
    const detail = await f.app.request("/v1/models/gemini-3.8-flash-tts", { headers: f.apiHeaders });
    assert.equal(detail.status, 200);
    assert.deepEqual(await detail.json(), speech);
    const local = await (await f.app.request("/api/models", { headers: f.uiHeaders })).json();
    const internalSpeech = local.models.find((model: { id: string }) => model.id === "gemini-3.8-flash-tts");
    assert.equal(internalSpeech.capabilities.provider, "google_vids");
    assert.equal(internalSpeech.capabilities.providerLabel, "Google Vids");
    const invalid = await f.app.request("/v1/chat/completions", {
      method: "POST",
      headers: f.apiHeaders,
      body: JSON.stringify({
        model: "qwen-web",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://invalid.test/image" },
              },
            ],
          },
        ],
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(f.store.listRequests().length, 0);
  } finally {
    await f.close();
  }
});

test("voice catalog exposes public Google Vids samples without a browser job", async () => {
  const f = await fixture();
  const path = "/v1/audio/voices?model=gemini-3.8-flash-tts";
  try {
    assert.equal((await f.app.request(path)).status, 401);
    const response = await f.app.request(path + "&language=ru_RU", { headers: f.apiHeaders });
    assert.equal(response.status, 200);
    const { voices, preview_languages } = await response.json();
    assert.equal(voices.length, 30);
    assert.equal(preview_languages.length, 23);
    assert.ok(preview_languages.includes("ru"));
    assert.equal(new Set(voices.map((voice: { voiceId: string }) => voice.voiceId)).size, 30);
    assert.deepEqual(voices.find((voice: { voiceId: string }) => voice.voiceId === "Schedar"), {
      voiceId: "Schedar",
      name: "Schedar",
      origin: "premade",
      style: "even",
      style_label: "Ровный",
      pitch: "medium-low",
      pitch_label: "Средне-низкий",
      description: "Ровный, средне-низкий тон",
      preview_url: "https://ssl.gstatic.com/docs/videos/audio/voice_samples/gemini-v4s-tts/1.1/ru/Schedar.wav",
      preview_language: "ru",
    });
    for (const voice of voices) {
      const url = new URL(voice.preview_url);
      assert.equal(url.origin, "https://ssl.gstatic.com");
      assert.equal(url.search, "");
      assert.equal(url.pathname.endsWith(`/ru/${voice.voiceId}.wav`), true);
      assert.equal(voice.name, voice.voiceId);
      assert.ok(voice.style && voice.style_label && voice.pitch && voice.pitch_label);
    }
    assert.equal(voices.find((voice: { voiceId: string }) => voice.voiceId === "Achernar").description, "Мягкий, высокий тон");
    const csp = response.headers.get("content-security-policy")!;
    assert.match(csp, /media-src 'self' data: blob: https:\/\/ssl\.gstatic\.com;/);
    for (const language of ["", "&language=uz-UZ"]) {
      const result = await (await f.app.request(path + language, { headers: f.uiHeaders })).json();
      assert.equal(result.voices[0].preview_language, "en");
      assert.equal(result.voices[0].preview_url.endsWith("/en/Achernar.wav"), true);
    }
    const filtered = await (await f.app.request(path + "&origins=cloned", { headers: f.apiHeaders })).json();
    assert.deepEqual(filtered.voices, []);
    const invalid = await f.app.request("/v1/audio/voices?model=qwen-web", { headers: f.apiHeaders });
    assert.equal(invalid.status, 404);
    assert.equal((await invalid.json()).error.code, "model_not_found");
    assert.equal(f.store.listRequests().length, 0);
  } finally {
    await f.close();
  }
});

test("local UI manages client API keys without login", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.request("/api/accounts")).status, 200);
    const headers = f.uiHeaders;
    const response = await f.app.request("/api/api-keys", {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "test key" }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(typeof created.secret, "string");
    assert(
      !JSON.stringify(
        await (await f.app.request("/api/api-keys", { headers })).json(),
      ).includes(created.secret),
    );
    assert.equal(
      (
        await f.app.request("/v1/models", {
          headers: { Authorization: `Bearer ${created.secret}` },
        })
      ).status,
      200,
    );
    await f.app.request(`/api/api-keys/${created.key.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(
      (
        await f.app.request("/v1/models", {
          headers: { Authorization: `Bearer ${created.secret}` },
        })
      ).status,
      401,
    );
    assert.equal((await f.app.request("/api/models", { headers })).status, 200);
    const config = await (
      await f.app.request("/api/config", { headers })
    ).json();
    assert.equal(config.publicApi.chatCompletions, "/v1/chat/completions");
    assert.equal("requests" in config.publicApi, false);
    assert.equal("generations" in config.publicApi, false);
  } finally {
    await f.close();
  }
});
test("local request views expose the journal without inventing leases or checkpoints", async () => {
  const f = await fixture();
  try {
    const record = f.host.submit(text),
      headers = f.uiHeaders;
    const rows = await (await f.app.request("/api/jobs", { headers })).json();
    assert.equal(rows[0].id, record.id);
    assert.equal(rows[0].status, "queued");
    assert.equal("lease_expires_at" in rows[0], false);
    assert.equal("deadline_at" in rows[0], false);
    const detail = await (
      await f.app.request(`/api/jobs/${record.id}`, { headers })
    ).json();
    assert.deepEqual(detail.request, text);
    assert.equal("checkpoint" in detail, false);
    const stats = await (await f.app.request("/api/stats", { headers })).json();
    assert.equal(stats.requests.total, 1);
    assert.equal(stats.jobs.queued, 1);
  } finally {
    await f.close();
  }
});
test("request history remains readable after a model is removed from the catalog", async () => {
  const f = await fixture();
  try {
    const record = f.store.createRequest({
      ...text,
      options: { ...text.options, model: "retired-model-id" },
    });
    f.store.failRequest(record.id, {
      code: "old_error",
      message: "Historical failure",
    });
    const headers = f.uiHeaders;
    const response = await f.app.request("/api/jobs", { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].model, "retired-model-id");
    assert.equal(
      (await f.app.request(`/api/jobs/${record.id}`, { headers })).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("static owner UI serves from its configured directory and upload requires an active request", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, "web"));
    await writeFile(
      join(f.dir, "web", "index.html"),
      "<html>fixture owner UI</html>",
    );
    const response = await f.app.request("/settings");
    assert.equal(response.status, 200);
    assert.match(await response.text(), /fixture owner UI/);
    assert.equal(
      (
        await f.app.request("/api/browser/files", {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "X-Request-Id": "missing",
            "X-Profile-Id": randomUUID(),
            Authorization: "Bearer bad",
          },
          body: new Uint8Array([1]),
        })
      ).status,
      403,
    );
    assert.equal((await f.app.request("/health/ready")).status, 200);
  } finally {
    await f.close();
  }
});
