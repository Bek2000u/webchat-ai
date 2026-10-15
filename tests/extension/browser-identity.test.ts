import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserRuntime,
  type BrowserSocket,
} from "../../src/extension/runtime/runtime.js";
import type { Hello } from "../../src/shared/contracts.js";

class MemoryStorage {
  values: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.values[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.values, values); }
}

function mockChrome(t: { after(fn: () => void): void }, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
}

async function connect(storage = new MemoryStorage()) {
  const messages: Hello[] = [];
  const handlers = new Map<string, () => void>();
  const socket = {
    active: false, connected: false,
    on(event: string, handler: () => void) { handlers.set(event, handler); return this; },
    emit(event: string, value: Hello) { if (event === "hello") messages.push(value); return this; },
    connect() { this.active = this.connected = true; handlers.get("connect")?.(); return this; },
    disconnect() { this.active = this.connected = false; handlers.get("disconnect")?.(); return this; },
  };
  const runtime = new BrowserRuntime([], storage, {
    extensionVersion: "identity-test",
    socketFactory: () => socket as unknown as BrowserSocket,
  });
  await runtime.initialize();
  await runtime.connect();
  assert.equal(runtime.ready, true);
  return { runtime, hello: messages[0], storage };
}

test("Chrome primary identity uses ANY, normalizes metadata and never forwards extra account data", async (t) => {
  let calls = 0;
  mockChrome(t, { identity: { getProfileUserInfo: async (details: unknown) => {
    calls++;
    assert.deepEqual(details, { accountStatus: "ANY" });
    return { email: " Chrome.Owner@Example.test ", id: " 123456 ", token: "must-not-leave", extra: "private" };
  } } });
  const env = await connect();
  assert.deepEqual(env.hello.browserIdentity, { email: "chrome.owner@example.test", id: "123456" });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(env.hello).includes("must-not-leave"), false);
  assert.equal(JSON.stringify(env.storage.values).includes("chrome.owner"), false);
  env.runtime.disconnect();
});

test("missing Chrome identity API, signed-out profile and API rejection do not block connection", async (t) => {
  mockChrome(t, undefined);
  for (const value of [
    undefined,
    {},
    { identity: { getProfileUserInfo: async () => ({ email: " ", id: "" }) } },
    { identity: { getProfileUserInfo: async () => { throw Error("identity unavailable"); } } },
  ]) {
    Object.defineProperty(globalThis, "chrome", { configurable: true, value });
    const env = await connect();
    assert.equal(Object.hasOwn(env.hello, "browserIdentity"), false);
    assert.equal(env.runtime.lastError, "");
    env.runtime.disconnect();
  }
});

test("Chrome email change across runtime restart preserves existing profile UUID and credential", async (t) => {
  let email = "first@example.test";
  mockChrome(t, { identity: { getProfileUserInfo: async () => ({ email, id: "" }) } });
  const storage = new MemoryStorage();
  const first = await connect(storage);
  first.runtime.disconnect();
  email = "second@example.test";
  const second = await connect(storage);
  assert.deepEqual(first.hello.browserIdentity, { email: "first@example.test" });
  assert.deepEqual(second.hello.browserIdentity, { email: "second@example.test" });
  assert.equal(second.hello.profileId, first.hello.profileId);
  assert.equal(second.hello.token, first.hello.token);
  assert.deepEqual(second.hello.providers, []);
  second.runtime.disconnect();
});

test("Chrome GAIA ID without email remains optional metadata, not a new profile key", async (t) => {
  mockChrome(t, { identity: { getProfileUserInfo: async () => ({ email: "", id: " 123456 " }) } });
  const env = await connect();
  assert.deepEqual(env.hello.browserIdentity, { id: "123456" });
  assert.notEqual(env.hello.profileId, "123456");
  env.runtime.disconnect();
});
