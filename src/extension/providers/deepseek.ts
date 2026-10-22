import { createAccountSession, isTransientTabExecutionError, providerSessionError } from "../runtime/tab.js";
import { type ProviderFailure } from "../runtime/runtime.js";
import {
  type TextSessionContext,
  type TextSessionTab,
  createUiTextGenerator,
  readTextUiDom,
  type TextUiDriver,
  createTextProvider,
} from "./text.js";

export const PROVIDER_ID = "deepseek_web";
const DEEPSEEK_URL = "https://chat.deepseek.com/";
const DEEPSEEK_SIGN_IN_PATH = /^\/(?:sign[-_]?in|login)(?:\/|$)/i;
function urlOf(tab: { url?: string; pendingUrl?: string }) {
  try {
    return new URL(tab?.url || tab?.pendingUrl || "");
  } catch {
    return null;
  }
}
export const TAB_CONFIG = Object.freeze({
  providerId: PROVIDER_ID,
  startUrl: DEEPSEEK_URL,
  queryUrl: "https://chat.deepseek.com/*",
  matches(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      url.hostname === "chat.deepseek.com" &&
      !DEEPSEEK_SIGN_IN_PATH.test(url.pathname)
    );
  },
  isSignIn(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      url.hostname === "chat.deepseek.com" &&
      DEEPSEEK_SIGN_IN_PATH.test(url.pathname)
    );
  },
  signInError: "Finish DeepSeek sign-in in the DeepSeek tab",
  notOpenError: "DeepSeek did not open",
});

// Injected into the page. The signed-in web app token is hashed in MAIN world;
// only the digest leaves the page. Guest pages must not advertise a worker:
// the current create-session endpoint rejects them inside an HTTP 200 envelope.
export async function detectDeepSeekPageContext() {
  if (
    location.protocol !== "https:" ||
    location.hostname !== "chat.deepseek.com"
  ) {
    throw new Error("DeepSeek page is unavailable") as ProviderFailure;
  }
  if (/^\/(?:sign[-_]?in|login)(?:\/|$)/i.test(location.pathname)) {
    throw new Error("Sign in to chat.deepseek.com first") as ProviderFailure;
  }
  let accountSecret = "";
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = String(localStorage.key(index) || "");
    if (!/(?:token|auth|user)/i.test(key)) continue;
    const candidate = String(localStorage.getItem(key) || "").trim();
    if (candidate.length > 20) {
      accountSecret = candidate;
      break;
    }
  }
  if (!accountSecret)
    throw new Error("Sign in to chat.deepseek.com first") as ProviderFailure;
  const bytes = new TextEncoder().encode(accountSecret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
  const accountSubject = `deepseek:${hex.slice(0, 40)}`;

  return {
    accountSubject,
  };
}
export function createDeepSeekSession(tab: TextSessionTab) {
  async function detectAccount() {
    try {
      const tabId = await tab.ensure(false);
      const detected = await tab.execute(detectDeepSeekPageContext, []);
      const currentContext = { ...detected, tabId };
      return currentContext as TextSessionContext;
    } catch (_caught) {
      const error = _caught as ProviderFailure;
      const message = String(error?.message || error);
      if (/sign in to chat\.deepseek\.com first/i.test(message)) {
        throw providerSessionError("PROVIDER_SIGN_IN_REQUIRED", message);
      }
      if (isTransientTabExecutionError(error)) {
        throw providerSessionError("DEEPSEEK_PAGE_UNAVAILABLE", message);
      }
      if (error?.code) throw error;
      throw providerSessionError(
        "DEEPSEEK_ACCOUNT_CHECK_FAILED",
        "DeepSeek account check failed; open the provider tab to review its state",
      );
    }
  }
  return createAccountSession(
    detectAccount,
    "DEEPSEEK_ACCOUNT_CHANGED",
    "DeepSeek account changed after extension registration",
  );
}

export const DEEPSEEK_DRIVER: TextUiDriver = {
  id: "DEEPSEEK", origin: "https://chat.deepseek.com",
  composer: 'textarea[name="search"]',
  send: '[role="button"].ds-button--primary.ds-button--circle:not(.ds-button--disabled)',
  // The collapsed desktop sidebar exposes only the new-chat SVG, no label.
  newChat: '[role="button"]:has(svg path[d^="M8 0.599609"]), [role="button"]:has(svg path[d^="M9.99994 1.22943"]), [tabindex="0"]:has(> :text-is("Новый чат")):not(a), [tabindex="0"]:has(> :text-is("New chat")):not(a), [role="button"][aria-label="New chat"]',
  isConversation: path => /\/a\/chat\/s\//.test(path),
  async read(page, structured) {
    const state = await page.evaluate(readTextUiDom, {
      composer: DEEPSEEK_DRIVER.composer,
      answers: '.ds-markdown:not(.ds-think-content .ds-markdown):not([class*="thinking"] .ds-markdown)',
      busy: '[role="button"].ds-button--primary.ds-button--circle:has(svg rect), button[aria-label="Stop generating"]',
      completed: '[role="button"].ds-button--primary.ds-button--circle.ds-button--disabled',
      errors: '[role="alert"]', structured,
    });
    const serviceError = await page.evaluate(() => {
      // Inspect displayed leaf messages, not arbitrary substrings in user prompts.
      return Array.from(document.querySelectorAll('div,p')).find(n =>
        !n.children.length && n.getClientRects().length &&
        /^(?:Сервер временно недоступен\.?|服务器繁忙[。.]?|(?:The )?server (?:is )?(?:temporarily )?(?:busy|unavailable)\.?)$/i.test(n.textContent?.trim() || ""))?.textContent?.trim();
    }, undefined);
    if (serviceError) state.error = serviceError;
    return state;
  },
  async thinking(page, mode) {
    const control = page.locator('[aria-pressed]:has-text("Глубокое мышление"), [aria-pressed]:has-text("DeepThink"), [aria-pressed]:has-text("深度思考")');
    const expected = String(mode === "deep");
    if (await control.getAttribute("aria-pressed") !== expected) await control.click();
    await page.waitFor(async () => await control.getAttribute("aria-pressed") === expected);
  },
};
export const generateDeepSeekText = createUiTextGenerator(DEEPSEEK_DRIVER);

export const createDeepSeekAdapter = createTextProvider(
  TAB_CONFIG,
  createDeepSeekSession,
  generateDeepSeekText,
);
