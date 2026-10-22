import assert from "node:assert/strict";
import test from "node:test";
import { afterEach, mock } from "node:test";
import { runInNewContext } from "node:vm";
import { createGoogleVidsSession, type PageTab } from "../../src/extension/providers/google-vids/index.js";
import { readGoogleVidsNativeState } from "../../src/extension/providers/google-vids/transport.js";
import { CrxPage } from "../../src/extension/playwright/index.js";

afterEach(() => mock.restoreAll());

function fixture(
  hookInstalled: boolean,
  access = "unlimited",
  options: {
    staleIdentity?: boolean;
    expiredSession?: boolean;
    noResult?: boolean;
    pageError?: boolean;
  } = {},
) {
  const attach = mock.method(CrxPage.prototype, "attach", async function (this: CrxPage) { return this; });
  mock.method(CrxPage.prototype, "detach", async () => {});
  mock.method(CrxPage.prototype, "evaluate", async () => true);
  mock.method(CrxPage.prototype, "locator", () => ({ isVisible: async () => false }) as never);
  const key = Symbol.for("workspaceCompanion.googleVids.transport.v1");
  const events: string[] = [];
  let reloads = 0;
  let submits = 0;
  let identityReady = !options.staleIdentity;
  const nativeState = () => ({
    observerVersion: 5,
    transport: { headers: [["x-server-token", "stays-in-page"]] },
    nativeXhrs: [{ sourcePath: "/v1/genai/quotaSummary" }],
    voiceoverAccess: { access, creditsTotal: access === "credit" ? 50 : 999999, creditsRemaining: access === "credit" ? 50 : 999999 },
    execute() {
      submits++;
    },
  });
  const page = {
    document: {
      documentElement: {
        getAttribute: () => (hookInstalled ? "native-v5" : ""),
      },
      querySelectorAll: () => [
        { getAttribute: () => "Account Owner@Example.Test" },
      ],
    },
    [key]: hookInstalled ? nativeState() : undefined,
  };
  const tab: PageTab = {
    async ensure(reload = false) {
      events.push(reload ? "reload" : "ensure");
      if (reload) {
        reloads++;
        if (options.expiredSession)
          throw Object.assign(
            Error("Finish Google sign-in for the Vids document"),
            { code: "PROVIDER_SIGN_IN_REQUIRED" },
          );
        identityReady = true;
        hookInstalled = true;
        page[key] = nativeState();
      }
      return 1;
    },
    async execute(func, args) {
      events.push(
        Object.is(func, readGoogleVidsNativeState) ? "hook" : "account",
      );
      if (!Object.is(func, readGoogleVidsNativeState)) {
        if (options.noResult) return undefined;
        if (options.pageError) throw Error("Network unavailable");
        if (!identityReady)
          return {
            accountSubject: "",
            error: {
              code: "GOOGLE_VIDS_ACCOUNT_IDENTITY_PENDING",
              message: "Google Vids account identity was not detected",
            },
          } as Awaited<ReturnType<typeof func>>;
      }
      return await runInNewContext(`(${func.toString()})(...args)`, {
        globalThis: page,
        document: page.document,
        Symbol,
        AbortController,
        setTimeout,
        clearTimeout,
        args,
        __name: (value: unknown) => value,
      });
    },
  };
  return {
    session: createGoogleVidsSession(tab),
    events,
    stats: () => ({ reloads, submits }),
    attachments: () => attach.mock.callCount(),
    invalidateHook: () => { page[key] = undefined; },
  };
}

test("Vids prepares a missing document_start hook before account detection, reloading once without generation", async () => {
  const f = fixture(false);
  const account = await f.session.detectAccount();
  assert.equal(account.accountSubject, "owner@example.test");
  assert.equal(account.accountTier, "paid");
  assert.equal(account.voiceoverAccess.access, "unlimited");
  assert.deepEqual(f.events, ["ensure", "hook", "hook", "reload", "hook", "account"]);
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
  assert.equal(f.attachments(), 1);
  assert.equal(JSON.stringify(account).includes("stays-in-page"), false);
  await f.session.verifyAccount("owner@example.test");
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
  assert.equal(f.attachments(), 1);
});

test("Vids with a ready hook does not reload on account checks", async () => {
  const f = fixture(true);
  await f.session.detectAccount();
  assert.deepEqual(f.events, ["ensure", "hook", "account"]);
  assert.deepEqual(f.stats(), { reloads: 0, submits: 0 });
  assert.equal(f.attachments(), 0);
});

test("Vids repeated ready account/preflight checks never attach the debugger", async () => {
  const f = fixture(true);
  for (let check = 0; check < 3; check++) {
    await f.session.detectAccount();
    await f.session.verifyAccount("owner@example.test");
  }
  assert.equal(f.attachments(), 0);
  assert.deepEqual(f.stats(), { reloads: 0, submits: 0 });
  assert.equal(f.events.filter(event => event === "account").length, 6);
  await assert.rejects(f.session.verifyAccount("different@example.test"), { code: "GOOGLE_VIDS_ACCOUNT_CHANGED" });
  assert.equal(f.attachments(), 0);
});

test("Vids lost readiness prepares the current document once, then stops attaching", async () => {
  const f = fixture(true);
  await f.session.detectAccount();
  assert.equal(f.attachments(), 0);
  f.invalidateHook();
  await f.session.detectAccount();
  assert.equal(f.attachments(), 1);
  await f.session.verifyAccount("owner@example.test");
  assert.equal(f.attachments(), 1);
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
});

test("Vids ready free account still checks paid access without a debugger", async () => {
  const f = fixture(true, "credit");
  await assert.rejects(f.session.detectAccount(), { code: "GOOGLE_VIDS_PAID_PLAN_REQUIRED" });
  assert.equal(f.attachments(), 0);
  assert.deepEqual(f.stats(), { reloads: 0, submits: 0 });
});

test("Vids hook preparation retains the actual account plan rejection", async () => {
  const f = fixture(false, "credit");
  await assert.rejects(f.session.detectAccount(), {
    code: "GOOGLE_VIDS_PAID_PLAN_REQUIRED",
    account: { accountSubject: "owner@example.test", accountTier: "free" },
  });
  await assert.rejects(f.session.verifyAccount("owner@example.test"), { code: "GOOGLE_VIDS_PAID_PLAN_REQUIRED" });
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
});

test("Vids unknown plan stays unavailable with account metadata and never submits", async () => {
  const f = fixture(true, "unrecognized");
  await assert.rejects(f.session.detectAccount(), {
    code: "GOOGLE_VIDS_PLAN_UNKNOWN",
    account: { accountSubject: "owner@example.test", accountTier: "unknown" },
  });
  assert.equal(f.stats().submits, 0);
});

test("Vids refreshes a stale cached editor once before account verification without generating", async () => {
  const f = fixture(true, "unlimited", { staleIdentity: true });
  await f.session.verifyAccount("owner@example.test");
  assert.deepEqual(f.events, [
    "ensure",
    "hook",
    "account",
    "reload",
    "hook",
    "account",
  ]);
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
});

test("Vids reports an actual sign-in redirect rather than identity pending", async () => {
  const f = fixture(true, "unlimited", {
    staleIdentity: true,
    expiredSession: true,
  });
  await assert.rejects(f.session.detectAccount(), {
    code: "PROVIDER_SIGN_IN_REQUIRED",
  });
  assert.deepEqual(f.stats(), { reloads: 1, submits: 0 });
});

test("Vids missing injected result is an execution error, not a missing account", async () => {
  const f = fixture(true, "unlimited", { noResult: true });
  await assert.rejects(f.session.detectAccount(), {
    code: "GOOGLE_VIDS_PAGE_EXECUTION_FAILED",
  });
  assert.deepEqual(f.stats(), { reloads: 0, submits: 0 });
});

test("Vids retains the original preparation failure instead of masking it as identity pending", async () => {
  const f = fixture(true, "unlimited", { pageError: true });
  await assert.rejects(f.session.detectAccount(), {
    code: "GOOGLE_VIDS_SESSION_FAILED",
    message: "Network unavailable",
  });
});
