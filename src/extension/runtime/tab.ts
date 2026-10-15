import { type ProviderFailure, type ProviderLogger, LOG_CODES, NOOP_LOG } from "./runtime.js";
import {
  readTab as getTab,
  waitForTab,
  queryTabs,
  createTab,
  reloadTab,
  activateTab,
} from "../playwright/index.js";

const keys = Object.freeze({
  flowRequests: crypto.randomUUID(),
});
/** Page-local cancellation/session slots live only for this extension runtime. */
export async function getPageStateKeys() {
  return keys;
}

export function createAccountSession<T extends { accountSubject: string }>(
  detectAccount: () => Promise<T>,
  code: string,
  message: string,
) {
  let pending: Promise<T> | undefined;
  const check = () => pending ??= Promise.resolve().then(detectAccount).finally(() => { pending = undefined; });
  return {
    detectAccount: check,
    async verifyAccount(expected = "") {
      expected = expected.trim().toLowerCase();
      const account = await check();
      if (expected && account.accountSubject !== expected)
        throw Object.assign(new Error(message), {
          code,
        }) satisfies ProviderFailure;
      return account;
    },
  };
}

export function requestSignal(
  signal: AbortSignal,
  additional?: AbortSignal | null,
) {
  return additional && additional !== signal
    ? AbortSignal.any([signal, additional])
    : signal;
}

export function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function providerSessionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function isTransientTabExecutionError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  return (
    /frame with id \d+ is showing error page/i.test(message) ||
    /no frame with id \d+/i.test(message) ||
    /frame with id \d+ was removed/i.test(message) ||
    /cannot access contents of the page[\s\S]*extension manifest must request permission/i.test(
      message,
    )
  );
}

export function classifyTabExecutionError(error: unknown) {
  if (
    /no current window/i.test(
      String(error instanceof Error ? error.message : error),
    )
  )
    return providerSessionError(
      "PROVIDER_WINDOW_UNAVAILABLE",
      "Open a browser window for this extension profile",
    );
  if (!isTransientTabExecutionError(error)) return error;
  return providerSessionError(
    "PROVIDER_PAGE_UNAVAILABLE",
    String(error instanceof Error ? error.message : error),
  );
}

export async function executeProviderScript<Args extends unknown[], Result>(
  tabId: number,
  func: (...args: Args) => Result,
  args: Args,
) {
  try {
    return await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func,
      args,
    });
  } catch (error) {
    throw classifyTabExecutionError(error);
  }
}

/** Bind local cancellation to the operation kept in the page's MAIN world. */
export function bindPageAbort(
  tabId: number,
  token: string,
  stateKey: string,
  signal?: AbortSignal,
) {
  const abort = async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (token: string, stateKey: string) => {
          const operations = (
            globalThis as unknown as Record<
              symbol,
              Map<string, { abort(): void }>
            >
          )[Symbol.for(stateKey)];
          operations?.get(token)?.abort();
        },
        args: [token, stateKey],
      });
    } catch {
      // Closing a tab already stops its page operations.
    }
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return () => signal?.removeEventListener("abort", abort);
}

export interface TabOptions {
  providerId: string;
  startUrl: string;
  queryUrl?: string | string[];
  sessionTabKey?: string;
  persistentUrlKey?: string;
  matches: (tab: Pick<chrome.tabs.Tab, "url">) => boolean;
  isSignIn: (tab: Pick<chrome.tabs.Tab, "url">) => boolean;
  signInError: string;
  notOpenError: string;
  timeoutMs?: number;
  log?: ProviderLogger;
}
export class ProviderTab {
  providerId: string;
  startUrl: string;
  queryUrl?: string | string[];
  persistentUrlKey: string;
  matches: TabOptions["matches"];
  isSignIn: TabOptions["isSignIn"];
  signInError: string;
  notOpenError: string;
  timeoutMs: number;
  log: ProviderLogger;
  storageKey: string;
  tabId: number | null;
  pending: Promise<number> | null;
  constructor({
    providerId,
    startUrl,
    queryUrl,
    sessionTabKey = "",
    persistentUrlKey = "",
    matches,
    isSignIn,
    signInError,
    notOpenError,
    timeoutMs = 20000,
    log = NOOP_LOG,
  }: TabOptions) {
    this.providerId = providerId;
    this.startUrl = startUrl;
    this.queryUrl = queryUrl;
    this.persistentUrlKey = persistentUrlKey;
    this.matches = matches;
    this.isSignIn = isSignIn;
    this.signInError = signInError;
    this.notOpenError = notOpenError;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.storageKey = sessionTabKey || `provider.tab:${providerId}`;
    this.tabId = null;
    this.pending = null;
  }

  async restore() {
    if (Number.isInteger(this.tabId)) return;
    const stored = await chrome.storage.session.get(this.storageKey);
    const candidate = Number(stored[this.storageKey]);
    if (Number.isInteger(candidate)) this.tabId = candidate;
  }

  async remember(tabId: number) {
    this.tabId = tabId;
    await chrome.storage.session.set({ [this.storageKey]: tabId });
  }

  async forget(tabId: number | null = null) {
    if (tabId !== null && this.tabId !== tabId) return;
    this.tabId = null;
    await chrome.storage.session.remove(this.storageKey);
  }

  async persistentUrl() {
    if (!this.persistentUrlKey) return "";
    const stored = await chrome.storage.local.get(this.persistentUrlKey);
    const value = String(stored[this.persistentUrlKey] || "");
    return value && this.matches({ url: value }) ? value : "";
  }

  async rememberPersistentUrl(value: string) {
    if (!this.persistentUrlKey || !this.matches({ url: value })) return;
    await chrome.storage.local.set({ [this.persistentUrlKey]: value });
  }

  async removed(tabId: number) {
    if (tabId === this.tabId) {
      this.log.info(LOG_CODES.TAB_CLOSED, { tab_id: tabId });
      await this.forget(tabId);
    }
  }

  async ensure(forceReload = false) {
    if (this.pending) return this.pending;
    this.pending = this.#ensure(forceReload);
    try {
      return await this.pending;
    } catch (error) {
      throw classifyTabExecutionError(error);
    } finally {
      this.pending = null;
    }
  }

  async #ensure(forceReload: boolean): Promise<number> {
    await this.restore();
    let tab = await getTab(this.tabId);
    if (tab && !this.matches(tab)) {
      if (this.isSignIn(tab)) {
        this.log.warn(LOG_CODES.TAB_SIGNIN_REQUIRED, { tab_id: tab.id });
        await activateTab(tab.id!);
        throw providerSessionError(
          "PROVIDER_SIGN_IN_REQUIRED",
          this.signInError,
        );
      }
      await this.forget(tab.id!);
      tab = null;
    }
    if (!tab && this.queryUrl) {
      const candidates = await queryTabs(this.queryUrl);
      tab = candidates.find((candidate) => this.matches(candidate)) || null;
    }
    // Only rediscover the saved extension-owned document. A stale session tab
    // ID after reload is not permission to create another scratch document.
    if (!tab && this.persistentUrlKey) {
      const saved = await this.persistentUrl();
      if (saved) {
        const own = new URL(saved);
        const candidates = await queryTabs(`${own.origin}${own.pathname}*`);
        tab = candidates.find(candidate => {
          if (!this.matches(candidate) || !candidate.url) return false;
          const current = new URL(candidate.url);
          return current.origin === own.origin && current.pathname === own.pathname;
        }) || null;
      }
    }
    if (
      tab?.status === "complete" &&
      Number.isInteger(tab.id) &&
      !tab.pendingUrl &&
      !forceReload
    ) {
      if (this.tabId !== tab.id) await this.remember(tab.id!);
      await this.rememberPersistentUrl(tab.url || "");
      return tab.id!;
    }
    if (!tab) {
      const persistentUrl = await this.persistentUrl();
      tab = await createTab(persistentUrl || this.startUrl);
      this.log.info(LOG_CODES.TAB_OPENED, { tab_id: tab.id });
    } else if (forceReload) {
      await reloadTab(tab.id!);
      this.log.info(LOG_CODES.TAB_RELOADED, { tab_id: tab.id });
    }
    if (!Number.isInteger(tab?.id)) {
      throw new Error(
        `Chrome did not create the ${this.providerId} provider tab`,
      );
    }
    await this.remember(tab.id!);
    await waitForTab(tab.id!, this.timeoutMs);
    await sleep(300);
    const ready = await getTab(tab.id!);
    if (!ready) {
      await this.forget(tab.id!);
      throw new Error(`${this.providerId} provider tab was closed`);
    }
    if (!this.matches(ready)) {
      await activateTab(ready.id!);
      throw providerSessionError(
        this.isSignIn(ready)
          ? "PROVIDER_SIGN_IN_REQUIRED"
          : "PROVIDER_PAGE_UNAVAILABLE",
        this.isSignIn(ready) ? this.signInError : this.notOpenError,
      );
    }
    await this.rememberPersistentUrl(ready.url || "");
    return ready.id!;
  }

  async open() {
    const tabId = await this.ensure(false);
    await activateTab(tabId);
    return tabId;
  }

  async execute<Args extends unknown[], Result>(
    func: (...args: Args) => Result,
    args: Args,
  ): Promise<Awaited<Result> | undefined> {
    const tabId = await this.ensure(false);
    const results = await executeProviderScript(tabId, func, args);
    return results?.[0]?.result as Awaited<Result> | undefined;
  }
}
