import { createAccountSession, providerSessionError } from "../runtime/tab.js";
import {
  type TextSessionTab,
  createUiTextGenerator,
  runTextUi,
  temporaryChat,
  type TextUiPage,
  type TextUiDriver,
  createTextProvider,
} from "./text.js";

export const PROVIDER_ID = "chatgpt_web";
export const TAB_CONFIG = {
  providerId: PROVIDER_ID,
  startUrl: "https://chatgpt.com/",
  queryUrl: "https://chatgpt.com/*",
  matches(tab: { url?: string }) {
    try {
      const url = new URL(tab.url || "");
      return (
        url.origin === "https://chatgpt.com" &&
        !/^\/auth(?:\/|$)/.test(url.pathname)
      );
    } catch {
      return false;
    }
  },
  isSignIn(tab: { url?: string }) {
    try {
      const url = new URL(tab.url || "");
      return (
        url.hostname === "auth.openai.com" ||
        url.hostname === "auth0.openai.com" ||
        (url.origin === "https://chatgpt.com" &&
          /^\/auth(?:\/|$)/.test(url.pathname))
      );
    } catch {
      return false;
    }
  },
  signInError: "Finish ChatGPT sign-in in the ChatGPT tab",
  notOpenError: "ChatGPT did not open",
};

/** The session stays in the page. Only a non-secret account identity leaves it. */
export async function detectChatGptAccount() {
  if (location.origin !== "https://chatgpt.com")
    throw Error("ChatGPT page is unavailable");
  const response = await fetch("/api/auth/session", {
    credentials: "include",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Sign in to chatgpt.com first");
  const session = await response.json();
  const identity = String(session?.user?.email || session?.user?.id || "")
    .trim()
    .toLowerCase();
  if (!identity) throw Error("Sign in to chatgpt.com first");
  const plan = String(session?.account?.planType || "").toLowerCase();
  const accountTier = plan === "free" ? "free" as const
    : ["plus", "pro", "go", "team", "business", "enterprise", "edu"].includes(plan) ? "paid" as const : "unknown" as const;
  return { accountSubject: identity, accountTier };
}
export function createChatGptSession(tab: TextSessionTab) {
  async function detectAccount() {
    try {
      const tabId = await tab.ensure(false);
      const account = await tab.execute(detectChatGptAccount, []);
      if (!account?.accountSubject) throw Error("Sign in to chatgpt.com first");
      return { accountSubject: account.accountSubject, accountTier: account.accountTier, tabId };
    } catch (error) {
      throw providerSessionError(
        "PROVIDER_SIGN_IN_REQUIRED",
        error instanceof Error
          ? error.message
          : "ChatGPT account could not be verified",
      );
    }
  }
  return createAccountSession(
    detectAccount,
    "CHATGPT_ACCOUNT_CHANGED",
    "ChatGPT account changed after extension registration",
  );
}

// Site selectors and answer extraction adapted from codex-chatgpt-web (MIT).
// Copyright (c) 2026 codex-chatgpt-web contributors; see LICENSES/codex-chatgpt-web.txt.

export const CHATGPT_COMPOSER =
  '[data-composer-markdown][contenteditable="true"][role="textbox"], [data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]';
export const CHATGPT_TURNS =
  '[data-talvt-turn-state]:has([data-markdown-text-style="assistant-message"]), [data-testid^="conversation-turn-"][data-turn="assistant"], [data-testid^="conversation-turn-"][data-message-author-role="assistant"], [data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])';
const NEW_CHAT =
  '[data-testid="create-new-chat-button"], a[data-testid="new-chat-button"], a[href="/"][data-sidebar-item], a:text-matches("^(new chat|новый чат|新聊天|新建聊天)$", "i"), button:text-matches("^(new chat|новый чат|新聊天|新建聊天)$", "i"), a:has(:text-matches("^(new chat|новый чат|新聊天|新建聊天)$", "i")), button:has(:text-matches("^(new chat|новый чат|新聊天|新建聊天)$", "i"))';
const SEND = `[data-testid="send-button"], button#composer-submit-button, form:has(${CHATGPT_COMPOSER}) button[type="submit"], button[type="submit"][aria-label="Send"], button[type="submit"][aria-label="Отправить"]`;
const TEMPORARY_CHAT =
  'button[aria-label="Временный чат"], button[aria-label="Temporary chat"], button[data-testid="temporary-chat-button"]';

/** DOM-only site interpretation. Input, clicks and readiness live in the CRX engine. */
export function readChatGptState(input: {
  composerSelector: string;
  turnSelector: string;
  structured: boolean;
}) {
  const visible = (node: Element) =>
    !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
    Boolean(node.getClientRects().length);
  const find = (selector: string, root: ParentNode = document) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector)).find(visible);
  const editor = find(input.composerSelector);
  function composerText(editor: HTMLElement) {
    if (editor instanceof HTMLTextAreaElement) return editor.value;
    const text = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (node instanceof Element && node.tagName === "BR") return "\n";
      return Array.from(node.childNodes).map(text).join("");
    };
    const nodes = Array.from(editor.childNodes);
    if (
      nodes.some(
        (node) => node instanceof Element && /^(P|DIV)$/.test(node.tagName),
      )
    ) {
      // Native Chromium insertText can leave the first line as a text node,
      // followed by DIVs; ProseMirror uses P blocks. Preserve both layouts.
      const parts: string[] = [];
      let inline = "";
      for (const node of nodes) {
        if (node instanceof Element && /^(P|DIV)$/.test(node.tagName)) {
          if (inline) {
            parts.push(inline);
            inline = "";
          }
          parts.push(
            node.childNodes.length === 1 &&
              node.firstChild instanceof Element &&
              node.firstChild.tagName === "BR"
              ? ""
              : text(node),
          );
        } else inline += text(node);
      }
      if (inline) parts.push(inline);
      return parts.join("\n");
    }
    return text(editor);
  }
  const turns = Array.from(
    document.querySelectorAll<HTMLElement>(input.turnSelector),
  ).filter(visible);
  const turn = turns.at(-1);
  const alert = find('[role="alert"]');
  // Native DIL renderer failures are role=status inside an otherwise complete
  // assistant turn, not role=alert and not an assistant's actual answer.
  const renderFailed = turn && find('[data-dil-render-failed]', turn);
  const error = renderFailed ? "ChatGPT could not render the response (data-dil-render-failed); the request was not replayed" : Boolean(
    alert &&
      /rate limit|too many requests|usage limit|try again|something went wrong|sign in|log in|лимит|ошибка|войдите/i.test(
        alert.innerText || alert.textContent || "",
      ),
  );
  const busy = Boolean(find('[data-testid="stop-button"]'));
  let value = "";
  if (turn) {
    const status = Array.from(
      turn.querySelectorAll("[data-streaming-response-status]"),
    ).find(visible);
    const roots = Array.from(
      turn.querySelectorAll<HTMLElement>(
        '[data-markdown-text-style="assistant-message"], .markdown, .puik-root.not-markdown > [class*="_DilResponseRoot"]',
      ),
    ).filter(
      (node, _i, candidates) =>
        visible(node) &&
        !candidates.some((other) => other !== node && other.contains(node)) &&
        !node.closest(
          '[data-testid^="cot-v5"], [data-streaming-response-status]',
        ) &&
        !(
          status &&
          node.compareDocumentPosition(status) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ),
    );
    const codes = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("pre code")),
    );
    function text(node: Node): string {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
      if (
        !(node instanceof Element) ||
        node.matches(
          "button, script, style, svg, img, picture, [hidden], [aria-hidden=true], .sr-only, [role=tooltip]",
        )
      )
        return "";
      if (node.tagName === "BR") return "\n";
      if (node.tagName === "PRE")
        return (
          "\n" +
          (node.querySelector("code")?.textContent || node.textContent || "") +
          "\n"
        );
      const content = Array.from(node.childNodes).map(text).join("");
      return /^(?:P|DIV|LI|TR|H[1-6]|BLOCKQUOTE|UL|OL)$/.test(node.tagName)
        ? "\n" + content + "\n"
        : content;
    }
    value =
      input.structured && codes.length === 1
        ? codes[0].textContent?.trim() || ""
        : roots
            .map((root) => text(root).trim())
            .filter(Boolean)
            .join("\n\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
  }
  const complete = Boolean(
    turn &&
      (turn.hasAttribute("data-talvt-turn-state")
        ? turn.getAttribute("data-talvt-turn-state") === "complete"
        : find('button[data-testid="copy-turn-action-button"]', turn)) &&
      !busy && !error,
  );
  return {
    origin: location.origin,
    path: location.pathname,
    temporary: /(?:^|[?&])temporary-chat=true(?:&|$)/.test(location.search || ""),
    composer: Boolean(editor),
    prompt: editor ? composerText(editor) : "",
    history: turns.length > 0,
    busy,
    error,
    text: error ? "" : value,
    complete,
  };
}

export const CHATGPT_DRIVER: TextUiDriver<ReturnType<typeof readChatGptState>> = {
  id: "CHATGPT", origin: "https://chatgpt.com",
  composer: CHATGPT_COMPOSER, send: SEND, newChat: NEW_CHAT,
  isConversation: path => /^\/c\//.test(path),
  read: (page, structured) => page.evaluate(readChatGptState, { composerSelector: CHATGPT_COMPOSER, turnSelector: CHATGPT_TURNS, structured }),
  ...temporaryChat("CHATGPT", TEMPORARY_CHAT),
  async thinking(page, mode) {
    const toggle = page.locator('button[aria-pressed]:has(svg use[href*="#brain-"]), button[aria-pressed]:text-is("Think"), button[aria-pressed]:text-is("Подумать")');
    if (await toggle.isVisible()) {
      const expected = String(mode === "deep");
      if (await toggle.getAttribute("aria-pressed") !== expected) await toggle.click();
      await page.waitFor(async () => await toggle.getAttribute("aria-pressed") === expected);
      return;
    }
    const menu = page.getByRole("button", { name: /Выбрать модель ChatGPT|Choose.*model|Select.*model/i });
    await menu.click();
    // Native keyboard control is separate from the hidden Radix thumb.
    // It advertises ArrowLeft/ArrowRight, not Home/End. Never select a model.
    const control = page.locator('[role="menu"] [role="menuitem"][data-reasoning-slider="true"]');
    const read = () => page.evaluate(() => {
      const slider = document.querySelector('[role="menu"] [data-reasoning-slider="true"] [role="slider"]');
      if (!slider) return null;
      const min = Number(slider.getAttribute("aria-valuemin")), max = Number(slider.getAttribute("aria-valuemax")), value = Number(slider.getAttribute("aria-valuenow"));
      return [min, max, value].every(Number.isInteger) && min <= value && value <= max ? { min, max, value } : null;
    }, undefined);
    let state = await page.waitFor(read);
    const target = mode === "fast" ? state.min : state.max;
    const direction = mode === "fast" ? -1 : 1;
    const steps = Math.abs(target - state.value);
    for (let step = 0; step < steps; step++) {
      const expected = state.value + direction;
      await control.press(direction < 0 ? "ArrowLeft" : "ArrowRight");
      state = await page.waitFor(async () => { const next = await read(); return next?.value === expected && next; });
    }
    await control.press("Escape");
    // Closing/reopening must retain effort; a transient slider preview is not enough.
    await menu.click();
    await page.waitFor(async () => (await read())?.value === target);
    await control.press("Escape");
  },
};
export type ChatGptPage = TextUiPage;
export const runChatGptUi = (page: TextUiPage, prompt: string, structured: boolean, timeoutMs = 600000) =>
  runTextUi(page, CHATGPT_DRIVER, prompt, structured, "default", timeoutMs);
export const generateChatGptText = createUiTextGenerator(CHATGPT_DRIVER);

export const createChatGptAdapter = createTextProvider(
  TAB_CONFIG,
  createChatGptSession,
  generateChatGptText,
);
