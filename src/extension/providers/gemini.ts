import { createAccountSession, isTransientTabExecutionError, providerSessionError } from "../runtime/tab.js";
import { type ProviderFailure } from "../runtime/runtime.js";
import {
  type TextSessionContext,
  type TextSessionTab,
  type DetectedPageContext,
  createUiTextGenerator,
  readTextUiDom,
  temporaryChat,
  type TextUiDriver,
  createTextProvider,
} from "./text.js";

// Static vendor facts: who Gemini Web is, which models exist, and how to
// recognize its tab. Nothing here decides anything at execution time.
export const PROVIDER_ID = "gemini_web";
const GEMINI_URL = "https://gemini.google.com/app";
const GEMINI_PATH = /^(?:\/u\/\d+)?\/app(?:\/|$)/i;
function urlOf(tab: { url?: string; pendingUrl?: string }) {
  try {
    return new URL(tab?.url || tab?.pendingUrl || "");
  } catch {
    return null;
  }
}
export const TAB_CONFIG = Object.freeze({
  providerId: PROVIDER_ID,
  startUrl: GEMINI_URL,
  queryUrl: "https://gemini.google.com/*",
  matches(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      url.hostname === "gemini.google.com" &&
      GEMINI_PATH.test(url.pathname)
    );
  },
  isSignIn(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return url?.protocol === "https:" && url.hostname === "accounts.google.com";
  },
  signInError: "Finish Google sign-in in the Gemini tab",
  notOpenError: "Gemini did not open",
});

// Who is logged in: account detection and re-check when the
// caller expects a specific account to still be the one signed in.

export const ACCOUNT_CHECK_TIMEOUT_MS = 30000;
export const GEMINI_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;
const ACCOUNT_TIMEOUT_MESSAGE = "Gemini account check timed out";
// This function is injected into Gemini's page world, so it must stay
// self-contained: closed-over extension constants are not available there.
export async function detectGeminiPageContext(timeoutMs: number) {
  const accountTimeoutMessage = "Gemini account check timed out";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let stage = "page";
  try {
    const pageText = String(
      globalThis.document?.body?.innerText || "",
    ).toLowerCase();
    if (
      pageText.includes(
        "application error: a client-side exception has occurred",
      )
    ) {
      throw new Error(
        "Gemini page has a client-side application error",
      ) as ProviderFailure;
    }
    const response = await fetch(location.href, {
      credentials: "include",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
    if (response.ok === false) {
      throw new Error(
        `Gemini account page returned HTTP ${response.status}`,
      ) as ProviderFailure;
    }
    const html = await response.text();
    if (!/"SNlM0e":\s*"/.test(html)) {
      throw new Error("Sign in to gemini.google.com first") as ProviderFailure;
    }
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const findEmail = () =>
      [...document.querySelectorAll("[aria-label]")]
        .map((node) => String(node.getAttribute("aria-label") || ""))
        .map((label) => label.match(emailPattern)?.[0] || "")
        .find(Boolean) || "";
    stage = "identity";
    let email = findEmail();
    while (!email && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      email = findEmail();
    }
    if (!email)
      throw new Error(
        "Gemini account identity was not detected",
      ) as ProviderFailure;
    const normalizedEmail = email.trim().toLowerCase();
    const tierLabel = document.querySelector(".mavatar-tier-label")?.textContent?.trim().toLowerCase() || "";
    const upsell = document.querySelector('[data-test-id="g1-dynamic-advanced-upsell-button"]');
    const accountTier = /^(?:google ai )?(?:plus|pro|ultra|advanced|business|enterprise|education)$/.test(tierLabel) ? "paid" as const
      : tierLabel === "free" || (!tierLabel && upsell && upsell.getClientRects().length > 0) ? "free" as const : "unknown" as const;

    return {
      // Keep the account list understandable to the user. Runtime and Server
      // event sanitizers redact this identity before anything reaches logs.
      accountSubject: normalizedEmail,
      accountTier,
    };
  } catch (_caught) {
    const error = _caught as ProviderFailure;
    if (controller.signal.aborted) {
      if (stage === "identity") {
        throw new Error(
          "Gemini account identity was not detected",
        ) as ProviderFailure;
      }
      throw new Error(accountTimeoutMessage) as ProviderFailure;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function pageContextFromError(error: ProviderFailure) {
  const message = String(error?.message || error);
  if (Boolean(error?.code)) throw error;
  if (/sign in to gemini\.google\.com first/i.test(message)) {
    throw providerSessionError("PROVIDER_SIGN_IN_REQUIRED", message);
  }
  if (/account identity was not detected/i.test(message)) {
    return { identityPending: true };
  }
  if (/client-side application error/i.test(message)) {
    return { pageError: true };
  }
  if (message.includes(ACCOUNT_TIMEOUT_MESSAGE)) {
    return { pageTimeout: true };
  }
  const httpStatus = message.match(/Gemini account page returned HTTP (\d{3})/);
  if (httpStatus) {
    throw providerSessionError(
      `GEMINI_ACCOUNT_HTTP_${httpStatus[1]}`,
      `Gemini account page returned HTTP ${httpStatus[1]}`,
    );
  }
  if (
    /failed to fetch|networkerror|network request failed|load failed/i.test(
      message,
    )
  ) {
    throw providerSessionError(
      "GEMINI_ACCOUNT_NETWORK_ERROR",
      "Gemini account page could not be reached; open the provider tab to review its state",
    );
  }
  if (isTransientTabExecutionError(error)) {
    return { pageUnavailable: true };
  }
  throw error;
}
export function createGeminiSession(
  tab: TextSessionTab,
  {
    accountTimeoutMs = ACCOUNT_CHECK_TIMEOUT_MS,
    now = () => Date.now(),
    reloadCooldownMs = GEMINI_RELOAD_COOLDOWN_MS,
  } = {},
) {
  let lastForcedReloadAt = Number.NEGATIVE_INFINITY;
  async function readPageContext(): Promise<DetectedPageContext | undefined> {
    try {
      return await tab.execute(detectGeminiPageContext, [accountTimeoutMs]);
    } catch (_caught) {
      const error = _caught as ProviderFailure;
      return pageContextFromError(error);
    }
  }
  async function readAccount() {
    let tabId = await tab.ensure(false);
    let detected = await readPageContext();
    const accountSubject = () =>
      String(detected?.accountSubject || "")
        .trim()
        .toLowerCase();
    const recoveryNeeded =
      detected?.identityPending ||
      detected?.pageError ||
      detected?.pageTimeout ||
      detected?.pageUnavailable ||
      !accountSubject();
    const checkedAt = now();
    if (recoveryNeeded && checkedAt - lastForcedReloadAt >= reloadCooldownMs) {
      lastForcedReloadAt = checkedAt;
      tabId = await tab.ensure(true);
      detected = await readPageContext();
    }
    if (detected?.pageUnavailable) {
      throw providerSessionError(
        "GEMINI_PAGE_UNAVAILABLE",
        "Gemini tab is still showing a Chrome error page after one reload",
      );
    }
    if (detected?.pageError) {
      throw providerSessionError(
        "GEMINI_PAGE_CRASH",
        "Gemini page still has a client-side application error after one reload",
      );
    }
    if (detected?.pageTimeout) {
      throw providerSessionError(
        "GEMINI_ACCOUNT_TIMEOUT",
        ACCOUNT_TIMEOUT_MESSAGE,
      );
    }
    const normalizedAccountSubject = accountSubject();
    if (!normalizedAccountSubject) {
      throw providerSessionError(
        "GEMINI_ACCOUNT_IDENTITY_PENDING",
        "Gemini account identity was not detected",
      );
    }
    const currentContext = {
      accountSubject: normalizedAccountSubject,
      accountTier: detected?.accountTier ?? "unknown",

      tabId,
    };
    return currentContext as TextSessionContext;
  }
  async function detectAccount() {
    try {
      return await readAccount();
    } catch (_caught) {
      const error = _caught as ProviderFailure;
      if (error?.code) throw error;
      // Unknown Chrome/page failures must not fall into the socket's 2s loop.
      throw providerSessionError(
        "GEMINI_ACCOUNT_CHECK_FAILED",
        "Gemini account check failed; open the provider tab to review its state",
      );
    }
  }
  return createAccountSession(
    detectAccount,
    "GEMINI_ACCOUNT_CHANGED",
    "Gemini account changed after extension registration",
  );
}

export const GEMINI_DRIVER: TextUiDriver = {
  id: "GEMINI", origin: "https://gemini.google.com",
  composer: 'rich-textarea [contenteditable="true"][role="textbox"]',
  send: 'button[aria-label="Отправить сообщение"], button[aria-label="Send message"], button[data-test-id="send-button"]',
  newChat: 'a[href="/app"][aria-label="Новый чат"], a[data-test-id="new-chat-button"], a[aria-label="New chat"][href$="/app"], a[href="/app"].gem-nav-list-item',
  // Reset the native page instead of relying on SPA history being unmounted.
  newChatUrl: "https://gemini.google.com/app",
  isConversation: path => /\/app\/[^/]+/.test(path),
  ...temporaryChat("GEMINI", 'button[aria-label="Временный чат"], button[aria-label="Temporary chat"]'),
  read: (page, structured) => page.evaluate(readTextUiDom, {
    composer: GEMINI_DRIVER.composer,
    answers: 'model-response message-content, model-response .markdown',
    busy: 'button[aria-label*="Остановить"], button[aria-label*="Stop"], model-response .loading-indicator',
    completed: 'model-response button[aria-label*="Копировать"], model-response button[aria-label*="Copy"], model-response .response-footer',
    errors: '[role="alert"]', structured,
    temporary: 'chat-window.is-temporary-chat',
  }),
  async thinking(page, mode) {
    const menu = page.getByRole("button", { name: /Выбор режима|Select mode|Choose.*mode|Open mode picker/i });
    await menu.click();
    await page.getByRole("menuitem", { name: /Уровень рассуждений|Thinking level|Reasoning level/i }).click();
    const label = mode === "fast" ? /Низкая|Low/i : /Высокая|High/i;
    await page.getByRole("menuitem", { name: label }).click();
    // Reopen the effort submenu to verify its checkmark, never a model item.
    await menu.click();
    await page.getByRole("menuitem", { name: /Уровень рассуждений|Thinking level|Reasoning level/i }).click();
    await page.waitFor(() => page.evaluate(mode => Array.from(document.querySelectorAll('[role="menuitem"].selected')).some(n =>
      (mode === "fast" ? /Низкая|Low/i : /Высокая|High/i).test(n.textContent || "")), mode));
    await menu.press("Escape");
    await menu.press("Escape");
  },
};
export const generateGeminiText = createUiTextGenerator(GEMINI_DRIVER);

export const createGeminiAdapter = createTextProvider(
  TAB_CONFIG,
  createGeminiSession,
  generateGeminiText,
);
