import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSender, startBackground } from "../../src/extension/background.js";
import { BrowserRuntime } from "../../src/extension/runtime/runtime.js";

test("extension settings work as a full Chrome tab and popup, but provider/content messages stay untrusted", () => {
  const id = "a".repeat(32),
    url = `chrome-extension://${id}/options.html`;
  assert.equal(isSettingsSender({ id, url }, id, url), true);
  assert.equal(
    isSettingsSender({ id, url, tab: { id: 1 } as chrome.tabs.Tab }, id, url),
    true,
  );
  assert.equal(
    isSettingsSender({ id, url: url + "?view=connection#settings" }, id, url),
    true,
  );
  for (const sender of [
    { id, url: "https://chatgpt.com/" },
    { id: "b".repeat(32), url },
    { id, url: url + "/evil" },
    { id, url: url.replace("options.html", "provider-context.js") },
    { id },
  ])
    assert.equal(isSettingsSender(sender, id, url), false);
});

test("actual background handler checks only its owned provider tab and manual target", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  let updated!: (id: number, change: chrome.tabs.OnUpdatedInfo, tab?: unknown) => void;
  let message!: (data: unknown, sender: unknown, respond: (value: unknown) => void) => void;
  const event = { addListener() {}, removeListener() {} };
  const storage = { async setAccessLevel() {}, async set() {}, async get() { return {}; } };
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    storage: { local: storage, session: storage },
    runtime: { id: "a".repeat(32), getManifest: () => ({ version: "test" }),
      getURL: (path: string) => `chrome-extension://${"a".repeat(32)}/${path}`,
      onStartup: event, onInstalled: event,
      onMessage: { addListener(listener: typeof message) { message = listener; }, removeListener() {} },
    },
    tabs: { onRemoved: event, onUpdated: { addListener(listener: typeof updated) { updated = listener; } } },
    alarms: { onAlarm: event, async create() {} },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "chrome", previous); else Reflect.deleteProperty(globalThis, "chrome"); });
  let runtime!: BrowserRuntime;
  const refreshed: (string | undefined)[] = [];
  t.mock.method(BrowserRuntime.prototype, "initialize", async function (this: BrowserRuntime) {
    runtime = this;
    this.settings = { profileId: "fixture", token: "fixture", serverOrigin: "http://127.0.0.1:8001" };
  });
  t.mock.method(BrowserRuntime.prototype, "connect", async function (this: BrowserRuntime) {
    this.ready = true;
    return { success: true, connected: true };
  });
  t.mock.method(BrowserRuntime.prototype, "publishProviders", async (providerId?: string) => { refreshed.push(providerId); });
  startBackground();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.ready, true);
  for (let index = 0; index < runtime.adapters.length; index++) {
    Object.assign(runtime.adapters[index].tab, { tabId: index + 1 });
  }
  updated(100, { status: "complete" }, { url: "https://example.test/" });
  updated(101, { status: "complete" }, { url: "https://docs.google.com/videos/d/not-our-document/edit" });
  updated(1, { status: "loading" });
  updated(1, { title: "Unrelated title change" });
  runtime.ready = false;
  updated(1, { status: "complete" });
  assert.deepEqual(refreshed, []);
  runtime.ready = true;
  for (let index = 0; index < runtime.adapters.length; index++) updated(index + 1, { status: "complete" });
  assert.deepEqual(refreshed, runtime.adapters.map(adapter => adapter.id));
  refreshed.length = 0;
  const response = await new Promise(resolve => message({ type: "provider", timestamp: Date.now(), data: { action: "refresh", provider: "qwen_web" } },
    { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/options.html` }, resolve));
  assert.deepEqual(response, { res: { success: true } });
  assert.deepEqual(refreshed, ["qwen_web"]);
  runtime.settings.serverToken="private-server-secret";
  const status=await new Promise(resolve=>message({type:"getStatus",timestamp:Date.now()},
    {id:"a".repeat(32),url:`chrome-extension://${"a".repeat(32)}/options.html`},resolve));
  assert.equal(JSON.stringify(status).includes("private-server-secret"),false);
});
