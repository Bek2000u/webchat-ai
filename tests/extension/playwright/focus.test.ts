import test from "node:test";
import assert from "node:assert/strict";
import { CrxPage } from "../../../src/extension/playwright/index.js";

function fixture() {
  const calls: Array<{ action: string; perform: boolean; value?: string }> = [];
  const page = new CrxPage(7, new AbortController().signal);
  page.transport.send = async () => { throw Error("Native input must never run"); };
  page.prepare = async (_selector, action, value, perform = false) => {
    calls.push({ action, perform, value });
    return { result: perform ? "done" : "ready", x: 10, y: 20 };
  };
  return { page, calls };
}

test("fill performs one document-bound edit without native/global input", async () => {
  const { page, calls } = fixture();
  await page.locator("[contenteditable]").fill("Only in the provider");
  assert.deepEqual(calls, [
    { action: "fill", perform: true, value: "Only in the provider" },
  ]);
});

test("click performs one document-bound action without native/global input", async () => {
  const { page, calls } = fixture();
  await page.locator("button").click();
  assert.deepEqual(calls, [
    { action: "click", perform: true, value: undefined },
  ]);
});

test("rerendered/not-ready target waits before the single atomic action, not after it", async () => {
  for (const action of ["fill", "click"] as const) {
    const { page } = fixture();
    let checks = 0, actions = 0;
    page.prepare = async (_selector, _action, _value, perform) => {
      assert.equal(perform, true);
      if (++checks < 3) return null; // nothing has been edited or clicked
      actions++;
      return { result: "done", x: 10, y: 20 };
    };
    await (action === "fill" ? page.locator("[contenteditable]").fill("Do not leak") : page.locator("button").click());
    assert.equal(actions, 1);
    assert.equal(checks, 3);
  }
});

test("key readiness and dispatch are also one atomic document call", async () => {
  const { page, calls } = fixture(); await page.locator("[data-reasoning-slider]").press("ArrowRight");
  assert.deepEqual(calls, [{ action: "press", perform: true, value: "ArrowRight" }]);
});

test("an action failure never replays the edit or Send", async () => {
  const { page, calls } = fixture();
  const prepare = page.prepare.bind(page);
  page.prepare = async (...args) => {
    const result = await prepare(...args);
    if (args[3]) throw Error("Document disconnected during action");
    return result;
  };
  await assert.rejects(page.locator("button").click(), /Document disconnected/);
  assert.equal(calls.filter(call => call.perform).length, 1);
});

test("new-chat navigation runs once and surfaces a native navigation error", async () => {
  const page = new CrxPage(7, new AbortController().signal);
  const calls: unknown[] = [];
  page.transport.send = async (method, params) => {
    calls.push({ method, params });
    return { errorText: "ERR_FAILED" } as never;
  };
  await assert.rejects(page.goto("https://gemini.google.com/app"), { code: "BROWSER_NAVIGATION_FAILED" });
  assert.deepEqual(calls, [{ method: "Page.navigate", params: { url: "https://gemini.google.com/app" } }]);
});
