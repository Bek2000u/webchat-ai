import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSession, requestSignal } from "../../src/extension/runtime/tab.js";
import { createFlowSession } from "../../src/extension/providers/flow/index.js";
import { createGoogleVidsSession } from "../../src/extension/providers/google-vids/index.js";
import { type ProviderTabLike } from "../../src/extension/runtime/runtime.js";
import { CrxPage } from "../../src/extension/playwright/index.js";

test("shared account check retains Flow/Vids site checks and detects account changes", async (t) => {
  t.mock.method(CrxPage.prototype, "attach", async function (this: CrxPage) { return this; });
  t.mock.method(CrxPage.prototype, "detach", async () => {});
  t.mock.method(CrxPage.prototype, "evaluate", async () => true);
  t.mock.method(CrxPage.prototype, "locator", () => ({ isVisible: async () => false }) as never);
  let subject = "owner@example.test";
  const tab = {
    ensure: async () => 1,
    execute: async () => ({
      email: subject,
      accountSubject: subject,
      apiReady: true,
      observerVersion: 5,
      transportReady: true,
      pageExecutorReady: true,
      nativeSeedCount: 1,
      voiceoverAccess: { access: "unlimited" },
    }),
  } as unknown as ProviderTabLike;
  for (const [session, code] of [
    [createFlowSession(tab), "FLOW_ACCOUNT_CHANGED"],
    [createGoogleVidsSession(tab), "GOOGLE_VIDS_ACCOUNT_CHANGED"],
  ] as const) {
    await session.verifyAccount(" Owner@Example.Test ");
    subject = "other@example.test";
    await assert.rejects(session.verifyAccount("owner@example.test"), { code });
    subject = "owner@example.test";
  }
  let calls = 0;
  const session = createAccountSession(
    async () => {
      calls++;
      return { accountSubject: subject };
    },
    "CHANGED",
    "Changed",
  );
  await session.detectAccount();
  await session.verifyAccount(subject);
  assert.equal(calls, 2);
});
test("shared request signal propagates either cancellation without changing the original", () => {
  const host = new AbortController(),
    caller = new AbortController();
  assert.equal(requestSignal(host.signal), host.signal);
  assert.equal(requestSignal(host.signal, host.signal), host.signal);
  const combined = requestSignal(host.signal, caller.signal);
  caller.abort("caller");
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, "caller");
  assert.equal(host.signal.aborted, false);
  const already = new AbortController();
  already.abort("host");
  assert.equal(
    requestSignal(already.signal, new AbortController().signal).reason,
    "host",
  );
});

test("concurrent account refresh and preflight share one check without a second debugger attachment", async () => {
  let calls = 0;
  let finish!: (account: { accountSubject: string }) => void;
  const session = createAccountSession(() => {
    calls++;
    return new Promise<{ accountSubject: string }>(resolve => { finish = resolve; });
  }, "CHANGED", "Changed");
  const first = session.detectAccount();
  const second = session.verifyAccount("owner@example.test");
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ accountSubject: "owner@example.test" });
  await Promise.all([first, second]);
});
