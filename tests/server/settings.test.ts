import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { BRIDGE_PATH, DEFAULT_TEXT_ROUTES, type Execute } from "../../src/shared/contracts.js";
import { loadSettings, saveSettings } from "../../src/server/settings.js";
import { startApi } from "../../src/server/index.js";

const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
async function directory(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "webchat-ai-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error("Settings fixture did not settle");
    await new Promise((done) => setTimeout(done, 10));
  }
}
async function runtime(t: test.TestContext, order = "gemini-web,qwen-web") {
  const dir = await mkdtemp(join(tmpdir(), "webchat-ai-settings-api-"));
  const instance = await startApi({
    DATA_DIR: dir, HOST: "127.0.0.1", PORT: "0",
    EXTENSION_ORIGINS: extensionOrigin,
    BOOTSTRAP_API_KEY: "settings-fixture-key",
    TEXT_PROVIDER_ORDER: order,
  });
  const address = instance.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await instance.close();
    await rm(dir, { recursive: true, force: true });
  });
  const config = () => fetch(base + "/api/config");
  const patch = (body: unknown, origin?: string) => fetch(base + "/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const generate = (model = "auto") => fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer settings-fixture-key" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "fixture" }] }),
  });
  async function profile() {
    const id = randomUUID(), socket = io(base, {
      path: BRIDGE_PATH, transports: ["websocket"], reconnection: false,
      extraHeaders: { Origin: extensionOrigin },
    });
    sockets.push(socket);
    const executions: Execute[] = [];
    socket.on("execute", (value: Execute) => executions.push(value));
    await new Promise<void>((done, fail) => {
      socket.once("connect", done);
      socket.once("connect_error", fail);
    });
    socket.emit("hello", {
      profileId: id, token: randomUUID(), extensionVersion: "fixture",
      providers: [{ id: "gemini_web", available: true }, { id: "qwen_web", available: true }],
    });
    await until(() => instance.host.connectedIds().has(id));
    return { id, socket, executions };
  }
  return { ...instance, dir, base, config, patch, generate, profile };
}

test("routing settings use saved order, then environment, then defaults", async (t) => {
  const dir = await directory(t);
  assert.deepEqual((await loadSettings(dir)).textProviderOrder, DEFAULT_TEXT_ROUTES);
  assert.deepEqual((await loadSettings(dir, ["qwen-web", "gemini-web"])).textProviderOrder, ["qwen-web", "gemini-web"]);
  await saveSettings(dir, { textProviderOrder: ["deepseek-web", "qwen-web", "deepseek-web"] });
  assert.deepEqual((await loadSettings(dir, ["gemini-web"])).textProviderOrder, ["deepseek-web", "qwen-web"]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")), { textProviderOrder: ["deepseek-web", "qwen-web"] });
  assert.deepEqual(await readdir(dir), ["settings.json"]);
  await saveSettings(dir, { textProviderOrder: ["chatgpt-web"] });
  assert.deepEqual((await loadSettings(dir)).textProviderOrder, ["chatgpt-web"]);
});

test("invalid saved routing is not silently overwritten or replaced by defaults", async (t) => {
  const dir = await directory(t);
  for (const text of ["{", JSON.stringify({ textProviderOrder: [] }), JSON.stringify({ textProviderOrder: ["auto"] })]) {
    await writeFile(join(dir, "settings.json"), text);
    await assert.rejects(loadSettings(dir));
    assert.equal(await readFile(join(dir, "settings.json"), "utf8"), text);
  }
});

test("config PATCH validates and persists routing, with local UI origin checks", async (t) => {
  const f = await runtime(t);
  const original = ["gemini-web", "qwen-web"];
  assert.deepEqual((await (await f.config()).json()).textProviderOrder, original);
  for (const invalid of [[], ["auto"], ["unknown"], ["nano-banana-2.1"]]) {
    assert.equal((await f.patch({ textProviderOrder: invalid })).status, 400);
    assert.deepEqual([...f.host.textRoutes], original);
  }
  assert.equal((await f.patch({ textProviderOrder: ["qwen-web"] }, "https://evil.test")).status, 403);
  assert.equal((await f.patch({ textProviderOrder: ["qwen-web"], retries: 99 })).status, 400);
  const order = ["qwen-web", "gemini-web"];
  const saved = await f.patch({ textProviderOrder: order });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).textProviderOrder, order);
  assert.deepEqual((await loadSettings(f.dir, ["chatgpt-web"])).textProviderOrder, order);
  await f.close();
  const restarted = await startApi({ DATA_DIR: f.dir, PORT: "0", TEXT_PROVIDER_ORDER: "chatgpt-web" });
  try { assert.deepEqual([...restarted.host.textRoutes], order); }
  finally { await restarted.close(); }
});

test("routing save failure leaves the active dispatcher unchanged and cleans temporary files", async (t) => {
  const f = await runtime(t);
  await mkdir(join(f.dir, "settings.json"));
  assert.equal((await f.patch({ textProviderOrder: ["qwen-web"] })).status, 500);
  assert.deepEqual([...f.host.textRoutes], ["gemini-web", "qwen-web"]);
  assert.equal((await readdir(f.dir)).some((name) => name.startsWith(".settings-")), false);
});

test("routing order applies immediately without touching an in-flight attempt or explicit provider", async (t) => {
  const f = await runtime(t), p = await f.profile();
  const first = f.generate();
  await until(() => p.executions.length === 1);
  const one = p.executions[0];
  assert.equal(one.request.options.model, "gemini-web");
  const firstAttempt = structuredClone(f.store.getRequest(one.id)?.attempts);
  const firstHealth = f.host.health(p.id, "gemini_web");
  assert.equal((await f.patch({ textProviderOrder: ["qwen-web", "gemini-web"] })).status, 200);
  assert.equal(f.store.getRequest(one.id)?.status, "running");
  assert.deepEqual(f.store.getRequest(one.id)?.attempts, firstAttempt);
  assert.deepEqual(f.host.health(p.id, "gemini_web"), firstHealth);
  const second = f.generate();
  await until(() => p.executions.length === 2);
  const two = p.executions[1];
  assert.equal(two.request.options.model, "qwen-web");
  for (const execution of [one, two]) p.socket.emit("result", {
    id: execution.id, attempt: execution.attempt, result: { text: "Settings fixture OK", chunks: [] },
  });
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  const explicit = f.generate("gemini-web");
  await until(() => p.executions.length === 3);
  const three = p.executions[2];
  assert.equal(three.request.options.model, "gemini-web");
  p.socket.emit("result", { id: three.id, attempt: three.attempt, result: { text: "Explicit fixture OK", chunks: [] } });
  assert.equal((await explicit).status, 200);
});
