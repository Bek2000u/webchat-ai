import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ProviderTab, bindPageAbort } from "../../src/extension/runtime/tab.js";
import { createGeminiSession } from "../../src/extension/providers/gemini.js";
import { createQwenSession } from "../../src/extension/providers/qwen.js";
import { createDeepSeekSession } from "../../src/extension/providers/deepseek.js";
import { type TextSessionTab } from "../../src/extension/providers/text.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
type TestTab = Pick<chrome.tabs.Tab, "id" | "url" | "status">;
function chromeGlobal(t: test.TestContext, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  Object.defineProperty(globalThis, "chrome", { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
}
function tabFixture(t: test.TestContext, existing = true) {
  const tabs = new Map<number, TestTab>(
    existing
      ? [[1, { id: 1, url: "https://provider.test/work", status: "complete" }]]
      : [],
  );
  const updated = new Set<
    (id: number, change: chrome.tabs.OnUpdatedInfo) => void
  >();
  const storage: Record<string, unknown> = existing
    ? { "provider.tab:test": 1 }
    : {};
  let reloads = 0,
    writes = 0,
    scriptCalls = 0;
  chromeGlobal(t, {
    storage: {
      session: {
        async get(key: string) {
          return { [key]: storage[key] };
        },
        async set(values: Record<string, unknown>) {
          writes++;
          Object.assign(storage, values);
        },
        async remove(key: string) {
          delete storage[key];
        },
      },
      local: {
        async get() {
          return {};
        },
        async set() {},
      },
    },
    tabs: {
      async get(id: number) {
        if (!tabs.has(id)) throw Error("closed");
        return { ...tabs.get(id)! };
      },
      async query() {
        return [];
      },
      async create(options: chrome.tabs.CreateProperties) {
        assert.equal(options.active, true, "Missing provider tabs must open as active tabs");
        const tab: TestTab = {
          id: 1,
          url: "https://provider.test/work",
          status: "loading",
        };
        tabs.set(1, tab);
        return { ...tab };
      },
      async reload(id: number) {
        reloads++;
        tabs.get(id)!.status = "loading";
      },
      async update() {},
      onUpdated: {
        addListener(
          fn: (id: number, change: chrome.tabs.OnUpdatedInfo) => void,
        ) {
          updated.add(fn);
        },
        removeListener(
          fn: (id: number, change: chrome.tabs.OnUpdatedInfo) => void,
        ) {
          updated.delete(fn);
        },
      },
    },
    scripting: {
      async executeScript({
        func,
        args,
      }: {
        func: (...args: unknown[]) => unknown;
        args: unknown[];
      }) {
        scriptCalls++;
        return [{ result: func(...args) }];
      },
    },
  });
  const tab = new ProviderTab({
    providerId: "test",
    startUrl: "https://provider.test/work",
    matches: (tab) => tab.url?.startsWith("https://provider.test/") === true,
    isSignIn: (tab) => tab.url?.startsWith("https://login.test/") === true,
    signInError: "Sign in required",
    notOpenError: "Wrong page",
  });
  return {
    tab,
    tabs,
    updated,
    stats: () => ({ reloads, writes, scriptCalls }),
    complete() {
      tabs.get(1)!.status = "complete";
      for (const fn of updated) fn(1, { status: "complete" });
    },
  };
}
test("repeated execution in a ready tab has no loading timers, reloads or repeated session writes", async (t) => {
  const fixture = tabFixture(t),
    timer = t.mock.method(globalThis, "setTimeout");
  assert.equal(await fixture.tab.ensure(), 1);
  for (let n = 0; n < 3; n++)
    assert.equal(
      await fixture.tab.execute((value: number) => value + 1, [n]),
      n + 1,
    );
  assert.equal(timer.mock.callCount(), 0);
  assert.deepEqual(fixture.stats(), { reloads: 0, writes: 0, scriptCalls: 3 });
  assert.equal(fixture.updated.size, 0);
  fixture.tabs.set(1, {
    id: 1,
    url: "https://login.test/",
    status: "complete",
  });
  await assert.rejects(
    fixture.tab.execute(() => true, []),
    /Sign in required/,
  );
  assert.equal(fixture.stats().scriptCalls, 3);
});
test("new tabs and forced reload still wait for completion and settle before execution", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = tabFixture(t, false);
  let finished = false;
  const first = fixture.tab.ensure().then((id) => {
    finished = true;
    return id;
  });
  await flush();
  assert.equal(finished, false);
  assert.equal(fixture.updated.size, 1);
  fixture.complete();
  await flush();
  assert.equal(finished, false);
  t.mock.timers.tick(300);
  assert.equal(await first, 1);
  finished = false;
  const reloaded = fixture.tab.ensure(true).then(() => {
    finished = true;
  });
  await flush();
  assert.equal(fixture.stats().reloads, 1);
  assert.equal(finished, false);
  fixture.complete();
  await flush();
  t.mock.timers.tick(300);
  await reloaded;
  assert.equal(fixture.updated.size, 0);
});

test("a profile with no browser window fails before page execution with a concrete error", async (t) => {
  const fixture = tabFixture(t, false);
  t.mock.method(chrome.tabs, "create", async () => { throw Error("No current window"); });
  await assert.rejects(fixture.tab.execute(() => true, []), {
    code: "PROVIDER_WINDOW_UNAVAILABLE",
    message: "Open a browser window for this extension profile",
  });
  assert.equal(fixture.stats().scriptCalls, 0);
  assert.equal(fixture.updated.size, 0);
});

test("reload rediscovers only the saved owned document instead of creating another tab", async (t) => {
  const f = tabFixture(t, false);
  f.tab.persistentUrlKey = "provider.workspace:test";
  f.tabs.set(42, { id: 42, url: "https://provider.test/work?scene=current", status: "complete" });
  f.tabs.set(43, { id: 43, url: "https://provider.test/other", status: "complete" });
  t.mock.method(chrome.storage.local, "get", async () => ({ "provider.workspace:test": "https://provider.test/work?scene=old" }));
  t.mock.method(chrome.tabs, "query", async () => [...f.tabs.values()] as chrome.tabs.Tab[]);
  t.mock.method(chrome.tabs, "create", async () => { throw Error("Must reuse the existing owned tab"); });
  assert.equal(await f.tab.ensure(), 42);
  assert.equal(f.tab.tabId, 42);
});
test("shared cancellation executes in MAIN world, targets one operation, and removes its listener", async (t) => {
  let aborts = 0,
    calls = 0;
  const page = {
    [Symbol.for("page.operations")]: new Map([
      [
        "target",
        {
          abort() {
            aborts++;
          },
        },
      ],
      [
        "other",
        {
          abort() {
            throw Error("Wrong operation");
          },
        },
      ],
    ]),
  };
  chromeGlobal(t, {
    scripting: {
      async executeScript(injection: {
        func: Function;
        args: unknown[];
        world: string;
      }) {
        calls++;
        assert.equal(injection.world, "MAIN");
        runInNewContext(`(${injection.func.toString()})(...args)`, {
          globalThis: page,
          args: injection.args,
          Symbol,
        });
        return [];
      },
    },
  });
  const controller = new AbortController(),
    unbind = bindPageAbort(1, "target", "page.operations", controller.signal);
  controller.abort();
  await flush();
  unbind();
  assert.equal(aborts, 1);
  assert.equal(calls, 1);
  const next = new AbortController(),
    detach = bindPageAbort(1, "target", "page.operations", next.signal);
  detach();
  next.abort();
  assert.equal(calls, 1);
  t.mock.method(chrome.scripting, "executeScript", () => {
    throw Error("Tab closed");
  });
  const closed = new AbortController();
  const detachClosed = bindPageAbort(
    1,
    "target",
    "page.operations",
    closed.signal,
  );
  assert.doesNotThrow(() => closed.abort());
  await flush();
  detachClosed();
});
test("each LLM session verifies the expected account per call without retaining it", async () => {
  for (const [factory, prefix] of [
    [createGeminiSession, "GEMINI"],
    [createQwenSession, "QWEN"],
    [createDeepSeekSession, "DEEPSEEK"],
  ] as const) {
    let account = "first@example.test";
    const tab: TextSessionTab = {
      async ensure() {
        return 1;
      },
      async execute() {
        return { accountSubject: account } as never;
      },
    };
    const session = factory(tab);
    await session.verifyAccount(account);
    account = "second@example.test";
    await assert.rejects(session.verifyAccount("first@example.test"), {
      code: prefix + "_ACCOUNT_CHANGED",
    });
    assert.equal(
      (await session.verifyAccount(account)).accountSubject,
      account,
    );
    assert.equal((await session.detectAccount()).accountSubject, account);
  }
});
