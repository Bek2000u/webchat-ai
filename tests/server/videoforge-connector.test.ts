import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "../client/fixture.js";
import { startApi } from "../../src/server/index.js";
import { Auth, KeyStore } from "../../src/server/auth.js";
import { VideoForgeConnector, connectorPathAllowed } from "../../src/server/videoforge-connector.js";

class Socket extends EventTarget {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  constructor(readonly url: string) { super(); }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(message: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "timed out waiting for connector"); await new Promise((done) => setTimeout(done, 5)); }
}
function wire(id: string, method = "POST", path = "/v1/chat/completions", value?: unknown) {
  return { type: "request", id, method, path, headers: { "content-type": "application/json" }, body: value === undefined ? "" : Buffer.from(JSON.stringify(value)).toString("base64") };
}
const prompt = { model: "gemini-web", messages: [{ role: "user", content: "Fixture only" }], stream: false };
function payload(response: Record<string, unknown>) { return JSON.parse(Buffer.from(String(response.body), "base64").toString()); }
async function setup(options?: { fetch?: (request: Request) => Response | Promise<Response> }) {
  const f = await fixture();
  const dir = f.files.root;
  const sockets: Socket[] = [];
  const connector = await VideoForgeConnector.open({ db: f.store.db, dataDir: dir, apiKey: "contract-key", fetch: options?.fetch ?? ((request) => f.app.fetch(request)),
    webSocketFactory: (url) => { const socket = new Socket(url); sockets.push(socket); return socket as unknown as WebSocket; }, reconnectDelays: [5] });
  await connector.update({ origin: "http://localhost:8080", token: "private-connector-token", enabled: true });
  connector.start();
  const socket = sockets[0];
  socket.open();
  socket.message({ type: "ready", version: 1, connectionId: "connector-fixture" });
  return { ...f, connector, socket, sockets, dir, async close() { await connector.close(); await f.close(); } };
}

test("authenticates once, relays real native Hono API, shares pending POST and replays completed receipt", async () => {
  const f = await setup();
  try {
    assert.equal(f.socket.url, "ws://localhost:8080/api/ai/connectors/connect");
    assert.deepEqual(f.socket.sent[0], { type: "authenticate", version: 1, token: "private-connector-token" });
    let release!: () => void;
    f.execute(async () => { await new Promise<void>((done) => { release = done; }); return { text: "One native execution" }; });
    const request = wire("stable-post", "POST", "/v1/chat/completions", prompt);
    f.socket.message(request);
    await until(() => f.calls.length === 1);
    assert.equal(f.store.db.prepare("SELECT response FROM videoforge_connector_requests WHERE request_id=?").get(request.id)?.response, null);
    f.socket.message(request);
    release();
    await until(() => f.socket.sent.filter((message) => message.id === request.id).length === 2);
    const first = f.socket.sent[1];
    assert.equal(first.status, 200);
    assert.equal(payload(first).choices[0].message.content, "One native execution");
    f.socket.message(request);
    await until(() => f.socket.sent.length === 4);
    assert.deepEqual(f.socket.sent[3], first);
    assert.equal(f.calls.length, 1);
    f.socket.message(wire("stable-post", "POST", "/v1/chat/completions", { ...prompt, model: "qwen-web" }));
    await until(() => f.socket.sent.length === 5);
    assert.equal(f.socket.sent[4].code, "request_conflict");
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("new connector instance replays SQLite response and refuses a persisted started claim", async () => {
  const f = await setup();
  let next: VideoForgeConnector | undefined;
  try {
    f.socket.message(wire("completed", "POST", "/v1/chat/completions", prompt));
    await until(() => f.socket.sent.length === 2);
    const completed = f.socket.sent[1];
    // This is the crash boundary: durable claim exists while execution has not returned.
    let release!: () => void;
    f.execute(async () => { await new Promise<void>((done) => { release = done; }); return { text: "Original still owns execution" }; });
    f.socket.message(wire("started", "POST", "/v1/chat/completions", prompt));
    await until(() => f.calls.length === 2);
    let socket!: Socket;
    let dispatches = 0;
    next = await VideoForgeConnector.open({ db: f.store.db, dataDir: f.dir, apiKey: "contract-key", fetch: () => { dispatches++; return new Response(); }, webSocketFactory: (url) => (socket = new Socket(url)) as unknown as WebSocket });
    next.start(); socket.open(); socket.message({ type: "ready", version: 1, connectionId: "connector-fixture" });
    socket.message(wire("completed", "POST", "/v1/chat/completions", prompt));
    socket.message(wire("started", "POST", "/v1/chat/completions", prompt));
    await until(() => socket.sent.length === 3);
    assert.deepEqual(socket.sent[1], completed);
    assert.equal(socket.sent[2].code, "outcome_unknown");
    assert.equal(dispatches, 0);
    release();
    await until(() => f.socket.sent.length === 3);
  } finally { await next?.close(); await f.close(); }
});

test("disconnect/reconnect does not resubmit an executing API call", async () => {
  const f = await setup();
  try {
    let release!: () => void;
    f.execute(async () => { await new Promise<void>((done) => { release = done; }); return { text: "Cached after socket outage" }; });
    const request = wire("socket-outage", "POST", "/v1/chat/completions", prompt);
    f.socket.message(request);
    await until(() => f.calls.length === 1);
    f.socket.close();
    await until(() => f.sockets.length === 2);
    const socket = f.sockets[1]; socket.open(); socket.message({ type: "ready", version: 1, connectionId: "connector-fixture" });
    release();
    await until(() => !!f.store.db.prepare("SELECT response FROM videoforge_connector_requests WHERE request_id=?").get(request.id)?.response);
    assert.equal(socket.sent.length, 1);
    socket.message(request);
    await until(() => socket.sent.length === 2);
    assert.equal(payload(socket.sent[1]).choices[0].message.content, "Cached after socket outage");
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test("GET status remains fresh, binary content preserves bytes and range headers", async () => {
  let dispatches = 0;
  const bytes = Uint8Array.from([0, 255, 4, 128, 21]);
  const f = await setup({ fetch: (request) => { dispatches++; return request.url.includes("/content")
    ? new Response(bytes, { status: 206, headers: { "content-type": "video/mp4", "content-range": "bytes 0-4/5", "set-cookie": "must-not-cross" } })
    : Response.json({ status: dispatches }); } });
  try {
    f.socket.message(wire("poll", "GET", "/v1/videos/native-id"));
    await until(() => f.socket.sent.length === 2);
    f.socket.message(wire("poll", "GET", "/v1/videos/native-id"));
    await until(() => f.socket.sent.length === 3);
    assert.notEqual(payload(f.socket.sent[1]).status, payload(f.socket.sent[2]).status);
    f.socket.message(wire("bytes", "GET", "/v1/videos/native-id/content"));
    await until(() => f.socket.sent.some((entry) => entry.id === "bytes" && entry.type === "response_end"));
    const frames = f.socket.sent.filter((entry) => entry.id === "bytes");
    assert.deepEqual(frames.map((entry) => entry.type), ["response_start", "response_chunk", "response_end"]);
    assert.equal(frames[0].status, 206);
    assert.deepEqual(Buffer.from(String(frames[1].body), "base64"), Buffer.from(bytes));
    assert.deepEqual(frames[0].headers, { "content-type": "video/mp4", "content-range": "bytes 0-4/5" });
  } finally { await f.close(); }
});

test("catalog and signed local file URLs use the same real Hono bridge", async () => {
  const f = await setup();
  try {
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const file = await f.files.put(new Blob([bytes]).stream(), "fixture-request", "image/png", () => true);
    // The native signed-file verifier owns authorisation; unsigned access is rejected.
    f.socket.message(wire("catalog", "GET", "/v1/models"));
    f.socket.message(wire("file", "GET", `/v1/files/${file.id}`));
    await until(() => f.socket.sent.some((entry) => entry.id === "file" && entry.type === "response_end") && f.socket.sent.some((entry) => entry.id === "catalog"));
    assert.ok((payload(f.socket.sent.find((entry) => entry.id === "catalog")!).data as unknown[]).length > 0);
    assert.equal(f.socket.sent.find((entry) => entry.id === "file")?.status, 403);
    const token = new Auth(new KeyStore(f.store.db, "contract-key"), "contract-file-secret").signFile(file.id);
    f.socket.message(wire("signed-file", "GET", `/v1/files/${file.id}?token=${token}`));
    await until(() => f.socket.sent.some((entry) => entry.id === "signed-file" && entry.type === "response_end"));
    const signedFrames = f.socket.sent.filter((entry) => entry.id === "signed-file");
    assert.equal(signedFrames[0].status, 200);
    assert.deepEqual(Buffer.concat(signedFrames.filter((entry) => entry.type === "response_chunk").map((entry) => Buffer.from(String(entry.body), "base64"))), Buffer.from(bytes));
  } finally { await f.close(); }
});

test("rejects admin/URL traversal, strips remote credentials, replaces bearer only locally", async () => {
  let dispatches = 0;
  const f = await setup({ fetch: (request) => {
    dispatches++;
    assert.equal(request.headers.get("authorization"), "Bearer contract-key");
    for (const name of ["cookie", "origin", "sec-fetch-site", "x-api-key", "host"]) assert.equal(request.headers.get(name), null);
    return Response.json({ ok: true });
  } });
  try {
    for (const path of ["/api/config", "https://evil.test/v1/models", "//evil.test/v1/models", "/v1/../api/config", "/v1/models#ignored", "/v1/files/%2e%2e%2fsecrets", "/v1/files/x\\..\\api"]) {
      f.socket.message(wire(`bad-${f.socket.sent.length}`, "GET", path));
      await until(() => f.socket.sent.length > 1);
    }
    await until(() => f.socket.sent.length === 8);
    assert.equal(dispatches, 0);
    const request = wire("safe", "GET", "/v1/models");
    Object.assign(request.headers, { Authorization: "Bearer SaaS-key", Cookie: "secret-cookie", Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin", "X-API-Key": "secret-key", Host: "evil.test" });
    f.socket.message(request);
    await until(() => f.socket.sent.length === 9);
    assert.equal(dispatches, 1);
    assert.ok(!JSON.stringify(f.socket.sent).includes("contract-key"));
  } finally { await f.close(); }
});

test("cancel aborts the local API operation; repeating cancelled POST never dispatches again", async () => {
  let dispatches = 0;
  let aborted = false;
  const f = await setup({ fetch: async (request) => {
    dispatches++;
    await new Promise<void>((_resolve, reject) => request.signal.addEventListener("abort", () => { aborted = true; reject(Error("cancelled")); }, { once: true }));
    return new Response();
  } });
  try {
    const request = wire("cancel-me", "POST", "/v1/chat/completions", prompt);
    f.socket.message(request);
    await until(() => dispatches === 1);
    f.socket.message({ type: "cancel", id: request.id });
    await until(() => f.socket.sent.length === 2);
    assert.equal(aborted, true);
    assert.equal(f.socket.sent[1].code, "outcome_unknown");
    f.socket.message(request);
    await until(() => f.socket.sent.length === 3);
    assert.equal(dispatches, 1);
  } finally { await f.close(); }
});

test("local Settings API is opt-in, masks credentials, preserves routing and validates origin", async () => {
  const f = await fixture();
  const instance = await startApi({ DATA_DIR: f.files.root, PORT: "0" });
  try {
    const get = (path: string) => instance.app.request(`http://127.0.0.1${path}`);
    const update = (value: unknown, headers: Record<string, string> = {}) => instance.app.request("http://127.0.0.1/api/videoforge/connector", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
    const original = await (await get("/api/config")).json();
    const initial = await (await get("/api/videoforge/connector")).json();
    assert.deepEqual(initial, { origin: "", tokenSaved: false, enabled: false, status: "disabled" });
    for (const origin of ["http://remote.example", "file:///etc/passwd", "https://user:pass@example.com", "https://example.com/path"]) assert.equal((await update({ origin, token: "secret", enabled: true })).status, 400);
    assert.equal((await update({ origin: "https://example.com", token: "secret", enabled: false }, { origin: "https://evil.test" })).status, 403);
    const saved = await update({ origin: "https://videoforge.example", token: "private-settings-token", enabled: false });
    assert.equal(saved.status, 200);
    const state = await saved.json();
    assert.equal(state.tokenSaved, true);
    assert.ok(!JSON.stringify(state).includes("private-settings-token"));
    const disk = JSON.parse(await readFile(join(f.files.root, "videoforge-connector.json"), "utf8"));
    assert.equal(disk.token, "private-settings-token");
    assert.deepEqual((await (await get("/api/config")).json()).textProviderOrder, original.textProviderOrder);
    assert.equal((await get("/api/api-keys")).status, 200);
    assert.deepEqual(await (await get("/api/api-keys")).json(), []);
    assert.equal((await instance.app.request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer invalid" } })).status, 401);
  } finally { await instance.close(); await f.close(); }
});

test("allowlist exposes existing native routes only", () => {
  for (const [method, path] of [["GET", "/v1/audio/voices"], ["GET", "/v1/files/uuid?token=signed&x=1"], ["GET", "/v1/models/flow-image"], ["POST", "/v1/images/edits"], ["POST", "/v1/responses"]]) assert.equal(connectorPathAllowed(method, path), true);
  for (const [method, path] of [["DELETE", "/v1/models"], ["POST", "/v1/files"], ["GET", "/api/api-keys"], ["GET", "/v1/files/../models"], ["GET", "/v1/files/%2Fapi"]]) assert.equal(connectorPathAllowed(method, path), false);
});

test("Go omitempty GET frames omit headers/body and still return catalog", async () => {
  const f = await setup();
  try {
    f.socket.message({ type: "request", id: "go-get", method: "GET", path: "/v1/models" });
    await until(() => f.socket.sent.length === 2);
    assert.equal(f.socket.sent[1].status, 200);
    assert.equal(f.connector.snapshot().status, "connected");
  } finally { await f.close(); }
});

test("process-style restart opens persisted SQLite journal and replays completed response", async () => {
  const f = await fixture();
  const path = join(f.files.root, "connector-journal.sqlite3");
  let db = new DatabaseSync(path);
  let connector: VideoForgeConnector | undefined;
  let socket!: Socket;
  let dispatches = 0;
  const open = async () => {
    connector = await VideoForgeConnector.open({ db, dataDir: f.files.root, apiKey: "contract-key", fetch: (request) => { dispatches++; return f.app.fetch(request); }, webSocketFactory: (url) => (socket = new Socket(url)) as unknown as WebSocket });
    await connector.update({ origin: "http://localhost:8080", token: "persisted-token", enabled: true });
    connector.start(); socket.open(); socket.message({ type: "ready", version: 1, connectionId: "persistent-connector" });
  };
  try {
    await open();
    const request = wire("persisted-post", "POST", "/v1/chat/completions", prompt);
    socket.message(request);
    await until(() => socket.sent.length === 2);
    const original = socket.sent[1];
    assert.equal(dispatches, 1);
    await connector!.close();
    db.close();
    db = new DatabaseSync(path);
    await open();
    socket.message(request);
    await until(() => socket.sent.length === 2);
    assert.deepEqual(socket.sent[1], original);
    assert.equal(dispatches, 1);
    assert.equal(f.calls.length, 1);
  } finally { await connector?.close(); db.close(); await f.close(); }
});

test("media GET starts before source completion and splits bounded chunks without a journal", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 71, 173);
  let finish!: () => void;
  const source = new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(bytes);
    await new Promise<void>((done) => { finish = done; });
    controller.close();
  } });
  const f = await setup({ fetch: () => new Response(source, { headers: { "content-type": "video/mp4" } }) });
  try {
    f.socket.message(wire("chunked", "GET", "/v1/videos/native-id/content"));
    await until(() => f.socket.sent.filter((entry) => entry.type === "response_chunk").length === 3);
    assert.equal(f.socket.sent[1].type, "response_start");
    assert.ok(!f.socket.sent.some((entry) => entry.type === "response_end"));
    const chunks = f.socket.sent.filter((entry) => entry.type === "response_chunk").map((entry) => Buffer.from(String(entry.body), "base64"));
    assert.ok(chunks.every((chunk) => chunk.byteLength <= 1024 * 1024));
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM videoforge_connector_requests").get()?.n, 0);
    finish();
    await until(() => f.socket.sent.at(-1)?.type === "response_end");
  } finally { finish(); await f.close(); }
});

test("cancel releases native media stream without completing or retrying download", async () => {
  let cancelled = false;
  let dispatches = 0;
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.from([1, 2, 3])); }, cancel() { cancelled = true; } });
  const f = await setup({ fetch: () => { dispatches++; return new Response(source, { headers: { "content-type": "video/mp4" } }); } });
  try {
    f.socket.message(wire("cancel-file", "GET", "/v1/files/native-id?token=signed"));
    await until(() => f.socket.sent.some((entry) => entry.type === "response_chunk"));
    f.socket.message({ type: "cancel", id: "cancel-file" });
    await until(() => f.socket.sent.some((entry) => entry.type === "error"));
    assert.equal(cancelled, true);
    assert.equal(dispatches, 1);
    assert.ok(!f.socket.sent.some((entry) => entry.type === "response_end"));
  } finally { await f.close(); }
});

test("cancel in the same receive turn prevents a pending POST API dispatch", async () => {
  let dispatches = 0;
  const f = await setup({ fetch: () => { dispatches++; return new Response(); } });
  try {
    f.socket.message(wire("cancel-before-dispatch", "POST", "/v1/chat/completions", prompt));
    f.socket.message({ type: "cancel", id: "cancel-before-dispatch" });
    await until(() => f.socket.sent.length === 2);
    assert.equal(dispatches, 0);
    assert.equal(f.socket.sent[1].code, "outcome_unknown");
  } finally { await f.close(); }
});
