import { createAccountSession, isTransientTabExecutionError, providerSessionError } from "../runtime/tab.js";
import { type ProviderFailure } from "../runtime/runtime.js";
import {
  type TextSessionContext,
  type TextSessionTab,
  createUiTextGenerator,
  readTextUiDom,
  temporaryChat,
  type TextUiDriver,
  createTextProvider,
} from "./text.js";

export const PROVIDER_ID = "qwen_web";
const QWEN_URL = "https://chat.qwen.ai/";
function urlOf(tab: { url?: string; pendingUrl?: string }) {
  try {
    return new URL(tab?.url || tab?.pendingUrl || "");
  } catch {
    return null;
  }
}
export const TAB_CONFIG = Object.freeze({
  providerId: PROVIDER_ID,
  startUrl: QWEN_URL,
  queryUrl: "https://chat.qwen.ai/*",
  matches(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return url?.protocol === "https:" && url.hostname === "chat.qwen.ai";
  },
  isSignIn(candidate: { url?: string; pendingUrl?: string }) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      url.hostname === "chat.qwen.ai" &&
      /^\/auth(?:\/|$)/i.test(url.pathname)
    );
  },
  signInError: "Finish Qwen sign-in in the Qwen tab",
  notOpenError: "Qwen did not open",
});

// Account identity must survive native access-token refresh. Only a hash of
// the authenticated user ID leaves MAIN; the rotating bearer stays here.
export async function detectQwenPageContext() {
  if (location.protocol !== "https:" || location.hostname !== "chat.qwen.ai") {
    throw new Error("Qwen page is unavailable") as ProviderFailure;
  }
  const token = String(localStorage.getItem("token") || "").trim();
  if (!token)
    throw new Error("Sign in to chat.qwen.ai first") as ProviderFailure;
  const response = await fetch("/api/v2/auths/", {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403)
    throw new Error("Sign in to chat.qwen.ai first") as ProviderFailure;
  const payload = await response.json();
  const id = payload?.success === true ? payload.data?.id : undefined;
  if (!response.ok || typeof id !== "string" || !id.trim())
    throw new Error("Qwen authenticated account ID is unavailable") as ProviderFailure;
  const bytes = new TextEncoder().encode(id);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");

  return {
    accountSubject: `qwen:${hex.slice(0, 40)}`,
  };
}
export function createQwenSession(tab: TextSessionTab) {
  async function detectAccount() {
    try {
      const tabId = await tab.ensure(false);
      const detected = await tab.execute(detectQwenPageContext, []);
      const currentContext = { ...detected, tabId };
      return currentContext as TextSessionContext;
    } catch (_caught) {
      const error = _caught as ProviderFailure;
      const message = String(error?.message || error);
      if (/sign in to chat\.qwen\.ai first/i.test(message)) {
        throw providerSessionError("PROVIDER_SIGN_IN_REQUIRED", message);
      }
      if (isTransientTabExecutionError(error)) {
        throw providerSessionError("QWEN_PAGE_UNAVAILABLE", message);
      }
      if (error?.code) throw error;
      throw providerSessionError(
        "QWEN_ACCOUNT_CHECK_FAILED",
        "Qwen account check failed; open the provider tab to review its state",
      );
    }
  }
  return createAccountSession(
    detectAccount,
    "QWEN_ACCOUNT_CHANGED",
    "Qwen account changed after extension registration",
  );
}

export const QWEN_DRIVER: TextUiDriver = {
  id: "QWEN", origin: "https://chat.qwen.ai",
  composer: 'textarea.message-input-textarea',
  send: 'button.send-button[aria-label="Send"]',
  newChat: 'button.temporary-chat-entry[aria-pressed="true"], [role="button"][aria-label="New Chat"], button:text-is("New Chat"), button:has(:text-is("New Chat")), button[aria-label="New Chat"]',
  isConversation: path => /\/(?:c|chat)\//.test(path),
  ...temporaryChat("QWEN", 'button.temporary-chat-entry'),
  read: (page, structured) => page.evaluate(readTextUiDom, {
    composer: QWEN_DRIVER.composer,
    answers: '.response-message-content .qwen-markdown, .chat-message-assistant .markdown, .response-message .markdown, [data-message-role="assistant"] .markdown',
    busy: 'button[aria-label="Stop"], button[aria-label="Stop generating"], .stop-button, .stop-response',
    completed: '.message-input-right-button-send [aria-label="Voice mode"], .response-message-footer, .chat-message-actions',
    errors: '[role="alert"]', structured,
    temporary: 'button.temporary-chat-entry[aria-pressed="true"]',
  }),
  async thinking(page, mode) {
    const selector = '.qwen-thinking-selector .qwen-chat-v2-dropdown-menu-trigger';
    const label = mode === "fast" ? "Fast" : "Thinking";
    if ((await page.locator(selector).textContent())?.trim() === label) return;
    await page.locator(selector).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    await page.waitFor(async () => (await page.locator(selector).textContent())?.trim() === label);
  },
};
export const generateQwenText = createUiTextGenerator(QWEN_DRIVER);

export const createQwenAdapter = createTextProvider(
  TAB_CONFIG,
  createQwenSession,
  generateQwenText,
);
