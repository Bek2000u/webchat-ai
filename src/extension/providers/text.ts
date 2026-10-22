import {
  type ProviderAdapter,
  type ProviderLogger,
  NOOP_LOG,
} from "../runtime/runtime.js";
import { ProviderTab, type TabOptions } from "../runtime/tab.js";
import {
  type AccountTier,
  modelSpec,
  thinkingModeSchema,
  type ThinkingMode,
  type TextDTO,
  type BrowserTextResult,
} from "../../shared/contracts.js";
import { withCrxPage, type CrxPage } from "../playwright/index.js";
import { accountError } from "../../shared/errors.js";

export function createTextProvider(
  tabConfig: Omit<TabOptions, "log">,
  createSession: (tab: TextSessionTab) => {
    detectAccount(): Promise<TextSessionContext>;
    verifyAccount(expected?: string): Promise<TextSessionContext>;
  },
  generate: (
    options: TextDTO,
    signal: AbortSignal,
    getContext: () => Promise<TextSessionContext>,
  ) => Promise<BrowserTextResult>,
) {
  return ({
    log = NOOP_LOG,
  }: { log?: ProviderLogger } = {}): ProviderAdapter => {
    const tab = new ProviderTab({ ...tabConfig, log }),
      session = createSession(tab);
    return {
      id: tabConfig.providerId,
      tab,
      detectAccount: session.detectAccount,
      text: (options, context) => {
        if (modelSpec(options.model)?.providerId !== tabConfig.providerId)
          throw new Error("Unsupported browser text model");
        return generate(options, context.signal, () =>
          session.verifyAccount(context.accountSubject),
        );
      },
    };
  };
}

export interface TextSessionContext {
  tabId: number;
  accountSubject: string;
  accountTier?: AccountTier;
}
export interface DetectedPageContext {
  accountSubject?: string;
  accountTier?: AccountTier;

  identityPending?: boolean;
  pageError?: boolean;
  pageTimeout?: boolean;
  pageUnavailable?: boolean;
}
export type TextSessionTab = Pick<
  import("../runtime/tab.js").ProviderTab,
  "ensure" | "execute"
>;
declare global {
  interface Navigator {
    readonly userAgentData?: {
      brands: Array<{ brand: string; version: string }>;
      platform?: string;
    };
  }
}

export function buildTextPrompt(options: TextDTO): string {
  const lines = [...(options.systemPrompts ?? [])];
  for (const message of options.messages) {
    if (
      typeof message.content !== "string" ||
      !["system", "user", "assistant"].includes(message.role)
    )
      throw new Error("Browser LLM messages must be user/assistant text");
    lines.push(`[${message.role}]\n${message.content}`);
  }
  if (options.outputSchema)
    lines.push(
      "Return exactly one JSON value matching this JSON Schema. Do not add Markdown or commentary.\n" +
        JSON.stringify(options.outputSchema),
    );
  const prompt = lines.join("\n\n").trim();
  if (!prompt) throw new Error("Text prompt is required");
  return prompt;
}
export type TextUiPage = Pick<
  CrxPage,
  "evaluate" | "locator" | "getByRole" | "waitFor" | "delay" | "signal" | "goto"
>;
export interface TextUiState {
  origin: string;
  path: string;
  composer: boolean;
  prompt: string;
  history: boolean;
  busy: boolean;
  error: boolean | string;
  text: string;
  complete: boolean;
  temporary?: boolean;
}
export interface TextUiDriver<S extends TextUiState = TextUiState> {
  id: string;
  origin: string;
  composer: string;
  send: string;
  newChat: string;
  newChatUrl?: string;
  isConversation(path: string): boolean;
  read(page: TextUiPage, structured: boolean): Promise<S>;
  prepare?(page: TextUiPage, read: () => Promise<S>): Promise<void>;
  validate?(state: S): void;
  thinking(
    page: TextUiPage,
    mode: Exclude<ThinkingMode, "default">,
  ): Promise<void>;
}
export function uiError(code: string, message: string): never {
  throw Object.assign(Error(message), { code });
}

/** Native temporary mode is required, never an ordinary-chat fallback. */
export function temporaryChat(
  id: string,
  selector: string,
): Pick<TextUiDriver, "prepare" | "validate"> {
  return {
    async prepare(page, read) {
      if (!(await read()).temporary) {
        await page.locator(selector).click();
        await page.waitFor(async () => (await read()).temporary);
      }
    },
    validate(state) {
      if (!state.temporary)
        uiError(
          `${id}_TEMPORARY_CHAT_UNAVAILABLE`,
          `${id} left temporary mode before Send; nothing was submitted`,
        );
    },
  };
}

/** One site invocation. Waits may poll; edit/Send never replay. */
export async function runTextUi<S extends TextUiState>(
  page: TextUiPage,
  driver: TextUiDriver<S>,
  prompt: string,
  structured: boolean,
  thinking: ThinkingMode = "default",
  timeoutMs = 600000,
) {
  let stage = "ready";
  try {
    let reportErrors = false;
    const read = async () => {
      page.signal.throwIfAborted();
      const state = await driver.read(page, structured);
      if (state.origin !== driver.origin)
        uiError(
          `${driver.id}_PAGE_CHANGED`,
          "Provider tab changed during execution",
        );
      if (reportErrors && state.error)
        uiError(
          `${driver.id}_UI_ERROR`,
          typeof state.error === "string"
            ? state.error
            : "Provider displayed a request error; review its tab",
        );
      return state;
    };
    const initial = await page.waitFor(async () => {
      const s = await read();
      return s.composer && s;
    });
    if (initial.busy)
      uiError(
        `${driver.id}_UI_BUSY`,
        "Provider already has an active response",
      );
    if (initial.history || driver.isConversation(initial.path)) {
      stage = "new_chat";
      if (driver.newChatUrl) await page.goto(driver.newChatUrl);
      else await page.locator(driver.newChat).click();
      await page.waitFor(async () => {
        const s = await read();
        return !driver.isConversation(s.path) && !s.history && s.composer;
      });
    }
    stage = "prepare";
    await driver.prepare?.(page, read);
    reportErrors = true;
    if (thinking !== "default") {
      stage = "thinking";
      try {
        await driver.thinking(page, thinking);
      } catch (error) {
        if (
          page.signal.aborted ||
          (error as { code?: string }).code === "outcome_unknown"
        )
          throw error;
        const cause = (error as { code?: string }).code;
        uiError(
          `${driver.id}_THINKING_UNAVAILABLE`,
          `The requested ${thinking} thinking mode could not be confirmed${cause ? ` (${cause})` : ""}; no prompt was sent`,
        );
      }
    }
    stage = "prompt";
    await page.locator(driver.composer).fill(prompt);
    const filled = await read();
    driver.validate?.(filled);
    if (filled.prompt.replace(/\r\n/g, "\n").trim() !== prompt.trim())
      uiError(
        `${driver.id}_PROMPT_MISMATCH`,
        "Provider composer did not preserve the complete prompt",
      );
    stage = "send";
    await page.locator(driver.send).click();
    stage = "response";
    let previous = "",
      stableSince = Date.now();
    try {
      return await page.waitFor(async () => {
        const state = await read();
        if (state.text !== previous) {
          previous = state.text;
          stableSince = Date.now();
        }
        return state.complete && state.text && Date.now() - stableSince >= 2000
          ? { text: state.text }
          : null;
      }, timeoutMs);
    } catch (error) {
      if ((error as { code?: string }).code === "BROWSER_UI_TIMEOUT")
        uiError(
          `${driver.id}_RESPONSE_TIMEOUT`,
          "Provider UI request timed out",
        );
      throw error;
    }
  } catch (caught) {
    const error =
      caught instanceof Error ? caught : Error("Browser UI request failed");
    const code = (caught as { code?: string } | null)?.code;
    if (code === "BROWSER_UI_TIMEOUT") {
      Object.assign(error, { code: `${driver.id}_UI_NOT_READY` });
      error.message = `${driver.id} UI did not become ready during ${stage}`;
    }
    // A click failure during Send is ambiguous, even if no response appeared.
    const beforeSend = !["send", "response"].includes(stage);
    const transient = /UI_NOT_READY$|PROMPT_MISMATCH$|^BROWSER_CONTEXT_LOST$/.test(String((error as { code?: string }).code));
    throw Object.assign(error, {
      stage, outcome: beforeSend ? "not_submitted" : "unknown",
      retryable: !page.signal.aborted && (beforeSend ? transient || accountError(String((error as { code?: string }).code)) : /_UI_ERROR$|_RESPONSE_TIMEOUT$|^outcome_unknown$|^BROWSER_CONTEXT_LOST$|^BROWSER_DISCONNECTED$/.test(String((error as { code?: string }).code))),
    });
  }
}

export function createUiTextGenerator<S extends TextUiState>(
  driver: TextUiDriver<S>,
) {
  return async (
    options: TextDTO,
    signal: AbortSignal,
    getContext: () => Promise<TextSessionContext>,
  ) => {
    signal.throwIfAborted();
    const thinking = thinkingModeSchema.parse(
      options.modelOptions?.thinking === undefined
        ? "default"
        : options.modelOptions.thinking,
    );
    const prompt = buildTextPrompt(options);
    const context = await getContext().catch((error) => {
      throw Object.assign(
        error instanceof Error ? error : Error("Provider account check failed"),
        { stage: "account", outcome: "not_submitted", retryable: true },
      );
    });
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(600000);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          return await withCrxPage(
        context.tabId,
        AbortSignal.any([signal, timeout]),
        (page) =>
          runTextUi(
            page,
            driver,
            prompt,
            Boolean(options.outputSchema),
            thinking,
          ),
          );
        } catch (error) {
          const failure = error as { code?: string; outcome?: string; retryable?: boolean };
          if (attempt || failure.outcome !== "not_submitted" || failure.retryable !== true || accountError(failure.code ?? "") || signal.aborted || timeout.aborted) throw error;
          // Retry preparation only. runTextUi marks Send/response failures unknown.
        }
      }
    } catch (error) {
      if (signal.aborted)
        uiError(
          "cancelled",
          "Request cancelled; the site may still be generating",
        );
      if (timeout.aborted)
        uiError(
          `${driver.id}_RESPONSE_TIMEOUT`,
          "Provider UI request timed out",
        );
      if ((error as { code?: string }).code === "BROWSER_UI_TIMEOUT")
        uiError(
          `${driver.id}_UI_NOT_READY`,
          "Provider UI did not become ready",
        );
      throw error;
    }
  };
}

/** Self-contained DOM reader; selectors and completion markers belong to sites. */
export function readTextUiDom(input: {
  composer: string;
  answers: string;
  busy: string;
  completed: string;
  errors: string;
  structured: boolean;
  temporary?: string;
}) {
  const visible = (n: Element) =>
    !n.closest('[hidden], [aria-hidden="true"], [inert]') &&
    !!n.getClientRects().length;
  const all = (selector: string) =>
    selector
      ? Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
          visible,
        )
      : [];
  const editor = all(input.composer)[0];
  function editText(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || "";
    if (n instanceof Element && n.tagName === "BR") return "\n";
    return Array.from(n.childNodes).map(editText).join("");
  }
  function richText(n: HTMLElement) {
    const parts: string[] = [];
    let inline = "";
    for (const child of Array.from(n.childNodes)) {
      if (child instanceof Element && /^(P|DIV)$/.test(child.tagName)) {
        if (inline) {
          parts.push(inline);
          inline = "";
        }
        parts.push(
          child.childNodes.length === 1 &&
            child.firstChild instanceof Element &&
            child.firstChild.tagName === "BR"
            ? ""
            : editText(child),
        );
      } else inline += editText(child);
    }
    if (inline) parts.push(inline);
    return parts.join("\n");
  }
  const prompt =
    editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement
      ? editor.value
      : editor
        ? richText(editor)
        : "";
  const roots = all(input.answers),
    answer = roots.at(-1);
  const errors = all(input.errors);
  const busy = all(input.busy).length > 0;
  function text(n: Node): string {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || "";
    if (
      !(n instanceof Element) ||
      n.matches(
        "button,script,style,svg,[hidden],[aria-hidden=true],.sr-only,[role=tooltip]",
      )
    )
      return "";
    if (n.tagName === "BR") return "\n";
    if (n.tagName === "PRE")
      return (
        "\n" +
        (n.querySelector("code")?.textContent || n.textContent || "") +
        "\n"
      );
    const value = Array.from(n.childNodes).map(text).join("");
    return /^(P|DIV|LI|TR|H[1-6]|BLOCKQUOTE|UL|OL)$/.test(n.tagName)
      ? "\n" + value + "\n"
      : value;
  }
  const codes = answer ? Array.from(answer.querySelectorAll("pre code")) : [];
  const value =
    input.structured && codes.length === 1
      ? codes[0].textContent?.trim() || ""
      : answer
        ? text(answer)
            .replace(/\n{3,}/g, "\n\n")
            .trim()
        : "";
  return {
    origin: location.origin,
    path: location.pathname,
    composer: Boolean(editor),
    prompt,
    history: roots.length > 0,
    busy,
    error: errors
      .map((n) => n.innerText || n.textContent)
      .filter(Boolean)
      .join("\n"),
    text: value,
    complete: Boolean(value && !busy && all(input.completed).length),
    temporary: all(input.temporary || "").length > 0,
  };
}
