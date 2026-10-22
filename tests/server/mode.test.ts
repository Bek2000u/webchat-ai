import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import { startApi } from "../../src/server/index.js";
import { BRIDGE_PATH, UPLOAD_PATH } from "../../src/shared/contracts.js";

const extensionOrigin = "chrome-extension://opcdjnhnokdpibdhglkjfohgnjokakfp";
const serverToken = "isolated-server-token";
const apiKey = "isolated-inference-key";
const admin = { Authorization: `Basic ${Buffer.from(`admin:${serverToken}`).toString("base64")}` };

async function fixture(mode: "desktop" | "server" = "server", publicOrigin?: string) {
  const parent = resolve("tmp/server-mode");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "fixture-"));
  await mkdir(join(directory, "web"));
  await writeFile(join(directory, "web", "index.html"), "<main>WebChat AI</main>");
  await writeFile(join(directory, "web", "app.js"), "console.log('dashboard');");
  const instance = await startApi({
    WEBCHAT_AI_MODE: mode,
    SERVER_TOKEN: mode === "server" ? serverToken : undefined,
    EXTENSION_ORIGINS: extensionOrigin,
    PORT: "0",
    DATA_DIR: directory,
    WEB_DIR: join(directory, "web"),
    BOOTSTRAP_API_KEY: apiKey,
    COMPANION_VERSION: mode === "desktop" ? "0.2.1" : undefined,
    PUBLIC_ORIGIN: publicOrigin,
  });
  const address = instance.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const sockets: Socket[] = [];
  function socket(token: string | undefined, origin = extensionOrigin) {
    const client = io(base, {
      path: BRIDGE_PATH,
      transports: ["websocket"],
      reconnection: false,
      timeout: 1000,
      auth: token === undefined ? {} : { serverToken: token },
      extraHeaders: { Origin: origin },
      autoConnect: false,
    });
    sockets.push(client);
    return client;
  }
  return { ...instance, base, address, socket, async cleanup() {
    for (const client of sockets) client.disconnect();
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  } };
}

test("server startup requires its token and explicit exact extension origins; desktop stays loopback", async () => {
  await assert.rejects(startApi({ WEBCHAT_AI_MODE: "other" }), /WEBCHAT_AI_MODE/);
  await assert.rejects(startApi({ HOST: "0.0.0.0" }), /loopback/);
  await assert.rejects(startApi({ WEBCHAT_AI_MODE: "server" }), /SERVER_TOKEN/);
  await assert.rejects(startApi({ WEBCHAT_AI_MODE: "server", SERVER_TOKEN: "token" }), /EXTENSION_ORIGINS/);
  await assert.rejects(startApi({ WEBCHAT_AI_MODE: "server", SERVER_TOKEN: "token", EXTENSION_ORIGINS: "*" }), /exact Chrome extension origins/);
  for (const origin of ["https://example.test/path", "https://user:password@example.test", "file:///data", "https://example.test?token=secret"])
    await assert.rejects(startApi({ PUBLIC_ORIGIN: origin }), /PUBLIC_ORIGIN/);
});

test("server dashboard is Basic-authenticated while native inference and signed-upload boundaries stay intact", async () => {
  const f = await fixture();
  try {
    assert.equal(f.address.address, "0.0.0.0");
    for (const path of ["/", "/dashboard", "/app.js", "/api/config", "/api/api-keys"]) {
      const denied = await fetch(f.base + path);
      assert.equal(denied.status, 401, path);
      assert.match(denied.headers.get("www-authenticate") ?? "", /^Basic /);
      const allowed = await fetch(f.base + path, { headers: admin });
      assert.equal(allowed.status, 200, path);
      assert.equal((await allowed.text()).includes(serverToken), false);
    }
    assert.equal((await fetch(f.base + "/health/ready")).status, 200);
    const health = await (await fetch(f.base + "/health")).json();
    assert.equal(health.status, "ok");
    assert.equal("extensionVersion" in health, false);
    assert.equal((await fetch(f.base + "/v1/models")).status, 401);
    assert.equal((await fetch(f.base + "/v1/models", { headers: { Authorization: `Bearer ${serverToken}` } })).status, 401);
    assert.equal((await fetch(f.base + "/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } })).status, 200);
    assert.equal((await fetch(f.base + "/v1/models", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 401);
    assert.equal((await fetch(f.base + "/v1/models", { headers: { ...admin, "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await fetch(f.base + "/api/config", { headers: { ...admin, Origin: "https://other.test" } })).status, 403);
    assert.equal((await fetch(f.base + "/api/config", { headers: { ...admin, "Sec-Fetch-Site": "same-site" } })).status, 403);
    // TLS termination must not break the authenticated, same-host dashboard.
    assert.equal((await f.app.request("http://webchat.example.test/api/config", { headers: { ...admin, Origin: "https://webchat.example.test", "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await fetch(f.base + UPLOAD_PATH, { method: "POST", body: "mock" })).status, 403);
    assert.equal(f.store.listRequests().length, 0);
  } finally { await f.cleanup(); }
});

test("server bridge checks the server token and extension origin before profile registration", async () => {
  const f = await fixture();
  try {
    for (const [token, origin] of [
      [undefined, extensionOrigin],
      ["incorrect", extensionOrigin],
      [serverToken, "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ] as const) {
      const client = f.socket(token, origin);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", () => reject(Error("Untrusted bridge was accepted")));
        client.once("connect_error", () => resolve());
        client.connect();
      });
      client.disconnect();
    }
    assert.equal(f.store.listProfiles().length, 0);
    const client = f.socket(serverToken);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    const profileId = randomUUID(), token = "isolated-profile-token-at-least-16";
    client.emit("hello", { profileId, token, extensionVersion: "test", providers: [] });
    const until = Date.now() + 2000;
    while (!f.host.connectedIds().has(profileId)) {
      assert(Date.now() < until, "Profile did not register");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(f.store.authenticateProfile(profileId, token));
    client.disconnect();
    const impostor = f.socket(serverToken);
    await new Promise<void>((resolve, reject) => {
      impostor.once("connect", resolve);
      impostor.once("connect_error", reject);
      impostor.connect();
    });
    const disconnected = new Promise<void>(resolve => impostor.once("disconnect", () => resolve()));
    impostor.emit("hello", { profileId, token: "a-different-profile-token", extensionVersion: "test", providers: [] });
    await disconnected;
    assert.equal(f.store.listProfiles().length, 1);
    assert.equal(f.store.listRequests().length, 0);
  } finally { await f.cleanup(); }
});

test("desktop keeps the existing login-free local UI and extension bridge", async () => {
  const f = await fixture("desktop");
  try {
    assert.equal(f.address.address, "127.0.0.1");
    assert.equal((await fetch(f.base + "/dashboard")).status, 200);
    assert.equal((await fetch(f.base + "/api/config", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await fetch(f.base + "/v1/models", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await f.app.request("http://external.example/api/config")).status, 403);
    assert.equal((await (await fetch(f.base + "/health")).json()).extensionVersion, "0.2.1");
    const client = f.socket(undefined);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
  } finally { await f.cleanup(); }
});

test("server media uploads retain active profile credentials and canonical HTTPS URLs behind a proxy", async () => {
  const f = await fixture("server", "https://webchat.example.test");
  try {
    const client = f.socket(serverToken);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
      client.connect();
    });
    const profileId = randomUUID(), token = "isolated-profile-token-at-least-16";
    client.emit("hello", { profileId, token, extensionVersion: "test", providers: [{ id: "flow", available: true }] });
    const until = Date.now() + 2000;
    while (!f.host.connectedIds().has(profileId)) {
      assert(Date.now() < until);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Isolated fake extension: no website or generation adapter is invoked.
    const record = f.host.submit({ kind: "image", options: { model: "nano-banana-2.1", prompt: "mock fixture" } });
    const headers = { "X-Profile-Id": profileId, "X-Request-Id": record.id, "Content-Type": "image/png" };
    assert.equal((await fetch(f.base + UPLOAD_PATH, { method: "POST", headers: { ...headers, Authorization: `Bearer ${serverToken}` }, body: new Uint8Array([1, 2, 3]) })).status, 403);
    const response = await fetch(f.base + UPLOAD_PATH, { method: "POST", headers: { ...headers, Authorization: `Bearer ${token}` }, body: new Uint8Array([1, 2, 3]) });
    assert.equal(response.status, 201);
    const uploaded = await response.json();
    const url = new URL(uploaded.url);
    assert.equal(url.origin, "https://webchat.example.test");
    assert.equal(uploaded.url.includes(token), false);
    const media = await fetch(f.base + url.pathname + url.search);
    assert.equal(media.status, 200);
    assert.deepEqual(new Uint8Array(await media.arrayBuffer()), new Uint8Array([1, 2, 3]));
  } finally { await f.cleanup(); }
});
