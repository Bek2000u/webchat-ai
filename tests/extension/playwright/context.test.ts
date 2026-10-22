import test from "node:test";
import assert from "node:assert/strict";
import { CrxPage } from "../../../src/extension/playwright/index.js";

function fixture() {
  const page = new CrxPage(7, new AbortController().signal);
  const injected = new Set<number>();
  let worlds = 0, evaluations = 0, failures = 0;
  let failure = () => Error('{"code":-32000,"message":"Cannot find context with specified id"}');
  page.transport.send = async (method, params) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } } as any;
    if (method === "Page.createIsolatedWorld") return { executionContextId: ++worlds } as any;
    assert.equal(method, "Runtime.evaluate");
    const id = params!.contextId as number;
    if (!injected.has(id)) { injected.add(id); return { result: {} } as any; }
    evaluations++;
    if (failures-- > 0) throw failure();
    return { result: { value: 42 } } as any;
  };
  return {
    page, stats: () => ({ worlds, evaluations }),
    fail: (count: number, error?: () => Error) => { failures = count; if (error) failure = error; },
    event: (method: string, params = {}) => page.transport.onEvent!(method, params),
  };
}

test("read reacquires a stale Qwen context once without another browser action", async () => {
  const f = fixture();
  await f.page.evaluate(() => 42, undefined);
  f.fail(1);
  assert.equal(await f.page.evaluate(() => 42, undefined), 42);
  assert.deepEqual(f.stats(), { worlds: 2, evaluations: 3 });
});

for (const method of ["Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Page.frameNavigated"])
  test(`${method} invalidates the document world before the next read`, async () => {
    const f = fixture();
    await f.page.evaluate(() => 42, undefined);
    f.event(method, { executionContextId: 1, frame: { id: "main" } });
    await f.page.evaluate(() => 42, undefined);
    assert.deepEqual(f.stats(), { worlds: 2, evaluations: 2 });
  });

test("another frame's destroyed context does not invalidate this world", async () => {
  const f = fixture();
  await f.page.evaluate(() => 42, undefined);
  f.event("Runtime.executionContextDestroyed", { executionContextId: 900 });
  await f.page.evaluate(() => 42, undefined);
  assert.equal(f.stats().worlds, 1);
});

test("context read retries are bounded", async () => {
  const f = fixture(); f.fail(10);
  await assert.rejects(f.page.evaluate(() => 42, undefined), { code: "BROWSER_CONTEXT_LOST" });
  assert.deepEqual(f.stats(), { worlds: 2, evaluations: 2 });
});

test("world creation interrupted by navigation cannot cache the old context", async () => {
  const f = fixture(), send = f.page.transport.send.bind(f.page.transport);
  let navigated = false;
  f.page.transport.send = async (method, params) => {
    const result = await send(method, params);
    if (!navigated && method === "Page.createIsolatedWorld") {
      navigated = true;
      f.event("Page.frameNavigated", { frame: { id: "main" } });
    }
    return result;
  };
  assert.equal(await f.page.evaluate(() => 42, undefined), 42);
  await f.page.evaluate(() => 42, undefined);
  assert.deepEqual(f.stats(), { worlds: 2, evaluations: 2 });
});

test("context loss during Send is outcome_unknown and never replays the action", async () => {
  const f = fixture(); f.fail(1);
  await assert.rejects(f.page.locator("button").click(), { code: "outcome_unknown" });
  assert.deepEqual(f.stats(), { worlds: 1, evaluations: 1 });
});

test("debugger disconnect is terminal, not a read-context retry", async () => {
  const f = fixture(); f.fail(1, () => Object.assign(Error("disconnected"), { code: "outcome_unknown" }));
  await assert.rejects(f.page.evaluate(() => 42, undefined), { code: "outcome_unknown" });
  assert.equal(f.stats().worlds, 1);
});
