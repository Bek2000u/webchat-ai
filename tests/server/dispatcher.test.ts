import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { BRIDGE_PATH, modelSpec, type Execute, type SDKRequest, type ProviderStatus, type RequestError } from "../../src/shared/contracts.js";
import { ApiStore } from "../../src/server/storage.js";
import { BrowserDispatcher } from "../../src/server/runtime.js";
import { FileStore } from "../../src/server/files.js";

const origin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const request: SDKRequest = {
  kind: "text",
  options: {
    model: "gemini-web",
    messages: [{ role: "user", content: "hello" }],
  },
};
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) throw Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(t: test.TestContext, routes?: readonly string[]) {
  const store = await ApiStore.open({ path: ":memory:" }),
    server = createServer(),
    host = new BrowserDispatcher(store, [origin], routes);
  host.attach(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  const sockets: Socket[] = [];
  t.after(async () => {
    sockets.forEach((s) => s.disconnect());
    await host.close();
    store.close();
  });
  async function connect(providers: ProviderStatus[] = [{ id: "gemini_web", available: true }]) {
    const id = randomUUID(),
      token = randomUUID();
    const socket = io(`http://127.0.0.1:${port}`, {
      path: BRIDGE_PATH,
      transports: ["websocket"],
      extraHeaders: { Origin: origin },
      reconnection: false,
    });
    sockets.push(socket);
    const executions: Execute[] = [];
    socket.on("execute", (value) => executions.push(value));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    const hello = () =>
      socket.emit("hello", {
        profileId: id,
        token,
        extensionVersion: "test",
        providers,
      });
    hello();
    await until(() => host.connectedIds().has(id));
    return { id, token, socket, executions, hello };
  }
  return { store, host, connect };
}
test("two profiles run in parallel; a busy profile receives no second execution", async (t) => {
  const { store, host, connect } = await setup(t),
    a = await connect(),
    b = await connect();
  const one = host.submit(request),
    two = host.submit(request),
    three = host.submit(request);
  await until(() => a.executions.length + b.executions.length === 2);
  assert.equal(store.getRequest(three.id)?.status, "pending");
  assert.notEqual(
    store.getRequest(one.id)?.profileId,
    store.getRequest(two.id)?.profileId,
  );
  a.socket.emit("result", {
    id: a.executions[0].id,
    result: { text: "done", chunks: [] },
  });
  await until(() => a.executions.length === 2);
  assert.equal(a.executions[1].id, three.id);
  // A different account cannot complete an invocation it does not own.
  b.socket.emit("result", { id: three.id, result: false });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.getRequest(three.id)?.status, "running");
});
test("disconnect ends running request as unknown, reconnect never submits it again", async (t) => {
  const { store, host, connect } = await setup(t),
    a = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  a.socket.disconnect();
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(store.getRequest(record.id)?.error?.code, "outcome_unknown");
  const next = await connect();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(next.executions.length, 0);
  assert.equal(store.pendingRequests().length, 0);
});

test("shutdown never dispatches pending work while disconnecting profiles", async (t) => {
  const { host, connect } = await setup(t),
    a = await connect(),
    b = await connect();
  host.submit(request);
  host.submit(request);
  host.submit(request);
  await until(() => a.executions.length + b.executions.length === 2);
  await host.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.executions.length + b.executions.length, 2);
});
test("cancel holds account slot until Chrome finishes; late result cannot change unknown", async (t) => {
  const { store, host, connect } = await setup(t),
    a = await connect();
  const first = host.submit(request);
  await until(() => a.executions.length === 1);
  host.cancel(first.id);
  assert.equal(store.getRequest(first.id)?.error?.code, "outcome_unknown");
  const next = host.submit(request);
  assert.equal(next.status, "pending");
  assert.equal(host.authorizeFile(a.id, a.token, first.id), false);
  a.socket.emit("result", {
    id: first.id,
    result: { text: "late", chunks: [] },
  });
  await until(() => a.executions.length === 2);
  assert.equal(store.getRequest(first.id)?.error?.code, "outcome_unknown");
  assert.equal(a.executions[1].id, next.id);
});
test("pending cancel never dispatches; browser error is terminal", async (t) => {
  const { store, host, connect } = await setup(t);
  const pending = host.submit(request);
  host.cancel(pending.id);
  const a = await connect();
  assert.equal(a.executions.length, 0);
  const current = host.submit(request);
  await until(() => a.executions.length === 1);
  a.socket.emit("error", {
    id: current.id,
    error: { code: "site_error", message: "Rejected" },
  });
  await until(() => store.getRequest(current.id)?.status === "error");
  a.hello();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.executions.length, 1);
});
test("restart preserves structured falsy results and fails incomplete requests without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser2api-store-test-")),
    path = join(directory, "host.sqlite3");
  let store = await ApiStore.open({ path });
  const pending = store.createRequest(request),
    running = store.createRequest(request),
    finished = store.createRequest(request);
  store.startRequest(running.id, "profile");
  store.startRequest(finished.id, "profile");
  store.completeRequest(finished.id, false);
  store.close();
  store = await ApiStore.open({ path });
  try {
    assert.equal(store.getRequest(finished.id)?.result, false);
    for (const id of [pending.id, running.id])
      assert.equal(store.getRequest(id)?.error?.code, "outcome_unknown");
    assert.deepEqual(store.pendingRequests(), []);
  } finally {
    store.close();
  }
});
test("files retain bytes and become unavailable for writes after execution ends", async () => {
  const store = await ApiStore.open({ path: ":memory:" }),
    directory = await mkdtemp(join(tmpdir(), "browser2api-file-test-"));
  try {
    const files = new FileStore(store.db, directory),
      bytes = new TextEncoder().encode("test file");
    const result = await files.put(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      "request",
      "text/plain",
      () => true,
    );
    assert.deepEqual(await readFile(result.path), Buffer.from(bytes));
    assert.equal(files.get(result.id)?.bytes, bytes.length);
    await assert.rejects(
      files.put(
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        "request",
        "text/plain",
        () => false,
      ),
    );
  } finally {
    store.close();
  }
});

const temporary: RequestError = { code: "CAPACITY", message: "Rejected before generation", outcome: "not_submitted", retryable: true, stage: "send" };
function fail(worker: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>>, execution: Execute, error: RequestError = temporary) {
  worker.socket.emit("error", { id: execution.id, attempt: execution.attempt, error });
}

test("round-robin remains fair when profiles are idle rather than always using the first", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  for (const worker of [a, b, a, b]) {
    const record = host.submit(request);
    await until(() => worker.executions.some(e => e.id === record.id));
    worker.socket.emit("result", { id: record.id, result: { text: "ok" } });
    await until(() => store.getRequest(record.id)?.status === "completed");
  }
  assert.equal(a.executions.length, 2);
  assert.equal(b.executions.length, 2);
});

test("common observed health prefers a healthy profile; an isolated profile is never permanently blocked", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  const first = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], { code: "NETWORK_ERROR", message: "Temporary network failure", retryable: false, outcome: "unknown" });
  await until(() => store.getRequest(first.id)?.status === "error");
  assert.equal(host.health(a.id, "gemini_web").lastError?.model, "gemini-web");
  assert.ok(host.health(a.id, "gemini_web").lastAssignedAt);
  for (let index = 0; index < 2; index++) {
    const record = host.submit(request);
    await until(() => b.executions.length === index + 1);
    b.socket.emit("result", { id: record.id, result: { text: "ok" } });
    await until(() => store.getRequest(record.id)?.status === "completed");
  }
  assert.ok(host.health(b.id, "gemini_web").lastSuccess);
  b.socket.disconnect();
  await until(() => !host.connectedIds().has(b.id));
  const manual = host.submit(request);
  await until(() => a.executions.length === 2);
  a.socket.emit("result", { id: manual.id, result: { text: "recovered" } });
  await until(() => store.getRequest(manual.id)?.status === "completed");
  assert.equal(host.health(a.id, "gemini_web").lastError, undefined);
});

test("prompt errors do not degrade provider health or another provider in the same profile", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], { code: "INVALID_PARAMETERS", message: "Bad input", retryable: false, outcome: "not_submitted" });
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(host.health(a.id, "gemini_web").lastError, undefined);
  assert.deepEqual(host.health(a.id, "flow"), {});
});

test("confirmed pre-submit rejection fails over once, keeps request ID and records both attempts", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect(), c = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0]);
  await until(() => b.executions.length === 1);
  assert.equal(b.executions[0].id, record.id);
  assert.equal(b.executions[0].attempt, 2);
  fail(b, b.executions[0]);
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(c.executions.length, 0);
  assert.deepEqual(store.getRequest(record.id)?.attempts.map(a => a.decision), ["retry", "failed"]);
  assert.ok(store.getRequest(record.id)?.attempts.every(a => a.error?.code === "CAPACITY" && a.durationMs! >= 0));
});

test("auto obeys configured provider order and preserves prompt and thinking across fallback", async (t) => {
  const { store, host, connect } = await setup(t, ["qwen-web", "gemini-web"]);
  const gemini = await connect(), qwen = await connect([{ id: "qwen_web", available: true }]);
  const input: SDKRequest = { ...request, options: { ...request.options, model: "auto", modelOptions: { thinking: "deep" } } };
  const record = host.submit(input);
  await until(() => qwen.executions.length === 1);
  assert.equal(qwen.executions[0].request.options.model, "qwen-web");
  fail(qwen, qwen.executions[0]);
  await until(() => gemini.executions.length === 1);
  assert.equal(gemini.executions[0].request.options.model, "gemini-web");
  assert.deepEqual(gemini.executions[0].request.options.modelOptions, { thinking: "deep" });
  assert.deepEqual((gemini.executions[0].request as typeof input).options.messages, input.options.messages);
  gemini.socket.emit("result", { id: record.id, attempt: 2, result: { text: "ok" } });
  await until(() => store.getRequest(record.id)?.status === "completed");
  assert.equal(store.getRequest(record.id)?.request.options.model, "auto");
});

test("explicit provider never falls back to a different site", async (t) => {
  const { store, host, connect } = await setup(t), gemini = await connect(), qwen = await connect([{ id: "qwen_web", available: true }]);
  const record = host.submit(request);
  await until(() => gemini.executions.length === 1);
  fail(gemini, gemini.executions[0], { ...temporary, code: "FLOW_AUTH_REJECTED" });
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(qwen.executions.length, 0);
});

for (const error of [
  { ...temporary, outcome: "unknown" as const, retryable: false },
  { ...temporary, outcome: "failed" as const, retryable: false },
  { ...temporary, retryable: undefined },
  { ...temporary, code: "INVALID_PARAMETERS", retryable: false },
  { ...temporary, code: "THINKING_UNAVAILABLE", retryable: false },
  { ...temporary, code: "POLICY_REJECTION", retryable: false },
]) test(`no unsafe retry: ${error.code}/${error.outcome}/${error.retryable}`, async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], error);
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(b.executions.length, 0);
  assert.equal(store.getRequest(record.id)?.attempts.length, 1);
});

test("completed invalid JSON can regenerate once on the only profile; old attempt events are ignored", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect();
  const input = { ...request, options: { ...request.options, outputSchema: { type: "object" } } } as SDKRequest;
  const record = host.submit(input);
  await until(() => a.executions.length === 1);
  a.socket.emit("result", { id: record.id, attempt: 1, result: { text: "broken JSON" } });
  await until(() => a.executions.length === 2);
  a.socket.emit("result", { id: record.id, attempt: 1, result: { text: "{\"stale\":true}" } });
  fail(a, a.executions[0]);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(store.getRequest(record.id)?.status, "running");
  a.socket.emit("result", { id: record.id, attempt: 2, result: { text: "{\"ok\":true}" } });
  await until(() => store.getRequest(record.id)?.status === "completed");
  assert.deepEqual(store.getRequest(record.id)?.result, { text: "{\"ok\":true}" });
  assert.deepEqual(store.getRequest(record.id)?.attempts.map(a => a.decision), ["retry", "completed"]);
});

test("auto skips unavailable/disabled profiles while free Flow remains eligible", async (t) => {
  const { store, host, connect } = await setup(t);
  const unavailable = await connect([{ id: "gemini_web", available: false }]);
  const disabled = await connect();
  store.updateProfile(disabled.id, { disabledProviders: ["gemini_web"] });
  const ready = await connect([{ id: "qwen_web", available: true }]);
  host.submit({ ...request, options: { ...request.options, model: "auto" } } as SDKRequest);
  await until(() => ready.executions.length === 1);
  assert.equal(unavailable.executions.length + disabled.executions.length, 0);
  const free = await connect([{ id: "flow", available: true, accountTier: "free" }]);
  const paid = await connect([{ id: "flow", available: true, accountTier: "paid" }]);
  host.submit({ kind: "video", options: { model: "gemini-omni-flash-preview", prompt: "test", size: "720p_economy", duration: 4 } });
  await until(() => free.executions.length === 1);
  assert.equal(paid.executions.length, 0);
});

test("Vids registers credit and unverified profiles as unavailable and dispatches only to paid", async (t) => {
  const { store, host, connect } = await setup(t);
  const free = await connect([{ id: "google_vids", available: true, accountTier: "free" }]);
  const unknown = await connect([{ id: "google_vids", available: true }]);
  const paid = await connect([{ id: "google_vids", available: true, accountTier: "paid" }]);
  const freeStatus = store.getProfile(free.id)!.providers[0];
  assert.equal(freeStatus.available, false);
  assert.equal(freeStatus.error?.code, "GOOGLE_VIDS_PAID_PLAN_REQUIRED");
  assert.equal(store.getProfile(unknown.id)!.providers[0].error?.code, "GOOGLE_VIDS_PLAN_PENDING");
  host.submit({ kind: "audio", options: { model: "gemini-3.8-flash-tts", prompt: "test" } });
  await until(() => paid.executions.length === 1);
  assert.equal(free.executions.length + unknown.executions.length, 0);
  const provider = { id: "google_vids", available: true, accountTier: "paid" } as const;
  free.socket.emit("hello", { profileId: free.id, token: free.token, extensionVersion: "test", providers: [provider] });
  await until(() => store.getProfile(free.id)!.providers[0].available);
  host.submit({ kind: "audio", options: { model: "gemini-3.8-flash-tts", prompt: "after upgrade" } });
  await until(() => free.executions.length === 1);
});

test("fallback waits for a busy alternative without freeing a cancelled account prematurely", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  const one = host.submit(request), occupied = host.submit(request);
  await until(() => a.executions.length + b.executions.length === 2);
  fail(a, a.executions[0]);
  await until(() => store.getRequest(one.id)?.status === "pending");
  host.cancel(one.id);
  b.socket.emit("result", { id: occupied.id, result: { text: "done" } });
  await until(() => store.getRequest(occupied.id)?.status === "completed");
  assert.equal(a.executions.length + b.executions.length, 2);
});

test("fresh SQLite uses generic tables and needs no legacy migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat2api-fresh-store-"));
  const path = join(directory, "app.sqlite3");
  const store = await ApiStore.open({ path });
  try {
    assert.deepEqual(store.db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name), ["profiles", "requests"]);
    assert.deepEqual(store.createRequest(request).attempts, []);
    assert.equal((await readdir(directory)).some(name => name.endsWith(".bak")), false);
    store.createProfile("chrome-profile", "secret");
    store.registerProfile("chrome-profile", "1", [{ id: "gemini_web", available: true, accountSubject: "site@example.com" }], { email: "chrome@example.com", id: "chrome-id" });
    store.registerProfile("chrome-profile", "2", [{ id: "gemini_web", available: true, accountSubject: "other-site@example.com" }], { email: "updated@example.com" });
    assert.equal(store.listProfiles().length, 1);
    assert.equal(store.getProfile("chrome-profile")?.browserIdentity?.email, "updated@example.com");
    assert.equal(store.getProfile("chrome-profile")?.providers[0].accountSubject, "other-site@example.com");
    store.registerProfile("chrome-profile", "3", []);
    assert.equal(store.getProfile("chrome-profile")?.browserIdentity, undefined, "Signed-out Chrome must not retain stale email metadata");
  } finally { store.close(); }
});

test("unknown outcome permits one fresh attempt on another profile without accepting the old result", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], { code: "outcome_unknown", message: "Lost result", outcome: "unknown", retryable: true });
  await until(() => b.executions.length === 1);
  a.socket.emit("result", { id: record.id, attempt: 1, result: { text: "stale" } });
  b.socket.emit("result", { id: record.id, attempt: 2, result: { text: "fresh" } });
  await until(() => store.getRequest(record.id)?.status === "completed");
  assert.deepEqual(store.getRequest(record.id)?.result, { text: "fresh" });
  assert.equal(store.getRequest(record.id)?.attempts[0].error?.outcome, "unknown");
});

test("socket loss follows the same bounded policy when another compatible worker is connected", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  a.socket.disconnect();
  await until(() => b.executions.length === 1);
  b.socket.emit("result", { id: record.id, attempt: 2, result: { text: "fresh" } });
  await until(() => store.getRequest(record.id)?.status === "completed");
  assert.equal(store.getRequest(record.id)?.attempts.length, 2);
});

test("invalid completed LLM outputs allow three total attempts, transport failure only two", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect();
  const record = host.submit(request);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => a.executions.length === attempt);
    a.socket.emit("result", { id: record.id, attempt, result: { text: "Something went wrong. Please try again." } });
  }
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(store.getRequest(record.id)?.error?.code, "LLM_TRANSIENT_RESPONSE");
  assert.equal(store.getRequest(record.id)?.attempts.length, 3);
  const next = host.submit(request);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await until(() => a.executions.length === 3 + attempt);
    fail(a, a.executions.at(-1)!, { code: "outcome_unknown", message: "Network failure", outcome: "unknown", retryable: true });
  }
  await until(() => store.getRequest(next.id)?.status === "error");
  assert.equal(store.getRequest(next.id)?.attempts.length, 2);
});

test("quota is request-local: no same-profile retry or permanent block, a new owner request remains allowed", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], { code: "FLOW_USER_QUOTA_REACHED", message: "Account quota", outcome: "not_submitted", retryable: true });
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(store.getProfile(a.id)?.enabled, true);
  const manual = host.submit(request);
  await until(() => a.executions.length === 2);
  assert.equal(a.executions[1].id, manual.id);
});

test("queue and retry share the original deadline instead of resetting the request window", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect();
  const record = host.submit(request);
  await until(() => a.executions.length === 1);
  store.db.prepare("UPDATE requests SET created_at=? WHERE id=?").run(new Date(Date.now() - 600100).toISOString(), record.id);
  fail(a, a.executions[0]);
  await until(() => store.getRequest(record.id)?.status === "error");
  assert.equal(a.executions.length, 1);
});

test("asynchronous video expires without any client wait or polling, including the pending queue", async (t) => {
  const { store, host, connect } = await setup(t);
  const model = modelSpec("gemini-omni-flash-preview")!, original = model.timeoutMs;
  try {
    model.timeoutMs = 80;
    const video: SDKRequest = { kind: "video", options: { model: model.id, prompt: "Fixture" } };
    const pending = host.submit(video);
    await until(() => store.getRequest(pending.id)?.status === "error");
    assert.equal(store.getRequest(pending.id)?.error?.code, "queue_timeout");
    const worker = await connect([{ id: "flow", available: true }]);
    const running = host.submit(video);
    await until(() => worker.executions.length === 1);
    await until(() => store.getRequest(running.id)?.status === "error");
    assert.equal(store.getRequest(running.id)?.error?.code, "EXTENSION_TIMEOUT");
    worker.socket.emit("result", { id: running.id, attempt: 1, result: { jobId: running.id, url: "https://media.test/stale" } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(store.getRequest(running.id)?.status, "error");
    assert.equal(worker.executions.length, 1);
  } finally { model.timeoutMs = original; }
});

test("auto can try another account for the requested thinking mode without downgrading it", async (t) => {
  const { store, host, connect } = await setup(t), a = await connect(), b = await connect([{ id: "qwen_web", available: true }]);
  const record = host.submit({ ...request, options: { ...request.options, model: "auto", modelOptions: { thinking: "deep" } } } as SDKRequest);
  await until(() => a.executions.length === 1);
  fail(a, a.executions[0], { code: "GEMINI_THINKING_UNAVAILABLE", message: "Deep unavailable", outcome: "not_submitted", retryable: true });
  await until(() => b.executions.length === 1);
  assert.deepEqual(b.executions[0].request.options.modelOptions, { thinking: "deep" });
  b.socket.emit("result", { id: record.id, attempt: 2, result: { text: "Deep answer" } });
  await until(() => store.getRequest(record.id)?.status === "completed");
});

test("confirmed upscale earns one window only; old attempts and expired executions cannot extend it", async (t) => {
  const { store, host, connect } = await setup(t), worker = await connect([{ id: "flow", available: true }]);
  const record = host.submit({ kind: "image", options: { model: "nano-banana-2-lite", prompt: "Fixture", size: "2k" } });
  await until(() => worker.executions.length === 1);
  const acknowledge = (attempt: number) => new Promise<boolean>(resolve => worker.socket.emit("upscale_ready", { id: record.id, attempt }, resolve));
  assert.equal(await acknowledge(2), false);
  assert.equal(await acknowledge(1), true);
  const stamp = store.getRequest(record.id)?.attempts[0].upscaleReadyAt;
  assert.ok(stamp);
  await new Promise(r => setTimeout(r, 15));
  assert.equal(await acknowledge(1), true);
  assert.equal(store.getRequest(record.id)?.attempts[0].upscaleReadyAt, stamp);
  host.cancel(record.id);
  assert.equal(await acknowledge(1), false);
});

test("upscale timeout replaces the generation window even for a waiting HTTP request", async (t) => {
  const { store, host, connect } = await setup(t), worker = await connect([{ id: "flow", available: true }]);
  const model = modelSpec("nano-banana-2-lite")!, original = model.timeoutMs;
  try {
    model.timeoutMs = 180;
    const record = host.submit({ kind: "image", options: { model: model.id, prompt: "Fixture", size: "2k" } });
    const completion = host.wait(record.id);
    await until(() => worker.executions.length === 1);
    const accepted = await new Promise<boolean>(resolve => worker.socket.emit("upscale_ready", { id: record.id, attempt: 1 }, resolve));
    assert.equal(accepted, true);
    await new Promise(r => setTimeout(r, 210));
    assert.equal(store.getRequest(record.id)?.status, "running");
    worker.socket.emit("result", { id: record.id, attempt: 1, result: { id: record.id, model: model.id, images: [] } });
    assert.equal((await completion).status, "completed");
  } finally { model.timeoutMs = original; }
});
