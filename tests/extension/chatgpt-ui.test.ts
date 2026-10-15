import test from "node:test";
import { afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import {
  runChatGptUi,
  generateChatGptText,
  readChatGptState,
  detectChatGptAccount,
} from "../../src/extension/providers/chatgpt.js";
import { parseSDKRequest, providerStatusSchema } from "../../src/shared/contracts.js";
import { CrxPage } from "../../src/extension/playwright/index.js";

afterEach(() => mock.restoreAll());

function fixture(
  options: {
    history?: boolean;
    complete?: boolean;
    disabled?: boolean;
    textarea?: boolean;
    structured?: boolean;
    currentComposer?: boolean;
    prompt?: string;
    draft?: string;
    keepDraftOnNewChat?: boolean;
    corruptInput?: boolean;
    currentResponse?: boolean;
    renderFailed?: boolean;
    responseText?: string;
    cachedHistory?: boolean;
    cachedComposer?: boolean;
    temporary?: boolean;
    temporaryUnavailable?: boolean;
    temporaryDoesNotActivate?: boolean;
    sendOutsideForm?: boolean;
  } = {},
) {
  const { window } = parseHTML(
    '<html><body><a data-testid="create-new-chat-button">New chat</a><button aria-label="Временный чат" data-testid="temporary-chat-button"></button><form data-chatgpt-composer>' +
      (options.textarea
        ? '<textarea id="prompt-textarea"></textarea>'
        : options.currentComposer
          ? '<div data-composer-markdown contenteditable="true" role="textbox" class="ProseMirror"></div>'
          : '<div id="prompt-textarea" contenteditable="true"></div>') +
      (options.currentComposer
        ? '<button type="button">Tools</button><button type="submit" aria-label="Отправить">Send</button>'
        : '<button data-testid="send-button">Send</button>') +
      "</form><main></main></body></html>",
  );
  const document = window.document,
    main = document.querySelector("main")!,
    editorSelector = options.currentComposer
      ? "[data-composer-markdown]"
      : "#prompt-textarea";
  let clicks = 0,
    newChats = 0,
    now = 0;
  let submitted = "";
  let temporaryClicks = 0, submittedInTemporary = false;
  mock.method(Date, "now", () => now);
  const controller = new AbortController();
  const location = {
    origin: "https://chatgpt.com",
    pathname: options.history ? "/c/old" : "/",
    search: options.temporary ? "?temporary-chat=true" : "",
  };
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: function (this: HTMLElement) {
      return this.closest(".cached-history") ? [] : [{}];
    },
  });
  const editor = document.querySelector(editorSelector)!;
  const temporaryButton = document.querySelector('[data-testid="temporary-chat-button"]')!;
  if (options.temporaryUnavailable) temporaryButton.remove();
  temporaryButton.addEventListener("click", () => {
    temporaryClicks++;
    if (!options.temporaryDoesNotActivate) location.search = "?temporary-chat=true";
  });
  if (options.cachedComposer) {
    const cached = document.createElement("form");
    cached.className = "cached-history";
    cached.setAttribute("data-chatgpt-composer", "");
    cached.innerHTML =
      '<div data-composer-markdown contenteditable="true" role="textbox"></div>';
    document.body.insertBefore(cached, editor.closest("form"));
  }
  const readEditor = () =>
    options.textarea
      ? (editor as unknown as { value: string }).value
      : options.currentComposer && editor.children.length
        ? Array.from(editor.children)
            .map((node) => node.textContent || "")
            .join("\n")
        : editor.textContent || "";
  const writeEditor = (value: string) => {
    if (options.currentComposer) {
      editor.replaceChildren(
        ...value.split("\n").map((line) => {
          const paragraph = document.createElement("p");
          if (line) paragraph.textContent = line;
          else paragraph.append(document.createElement("br"));
          return paragraph;
        }),
      );
    } else editor.textContent = value;
  };
  if (options.currentComposer)
    Object.defineProperty(editor, "innerText", {
      get: () =>
        Array.from(editor.children)
          .map((node) => node.textContent || "")
          .join("\n\n"),
    });
  if (options.draft) writeEditor(options.draft);
  document.querySelector("a")!.addEventListener("click", () => {
    newChats++;
    if (options.cachedHistory)
      main
        .querySelectorAll("article, [data-talvt-turn-state]")
        .forEach((node) => node.classList.add("cached-history"));
    else main.innerHTML = "";
    location.pathname = "/";
    location.search = "";
    if (!options.keepDraftOnNewChat) writeEditor("");
  });
  if (options.history || options.cachedHistory)
    main.innerHTML = `<article ${options.cachedHistory && !options.history ? 'class="cached-history"' : ""} data-testid="conversation-turn-old" data-turn="assistant"><div class="markdown">Old answer</div></article>`;
  const send = document.querySelector(
    options.currentComposer ? 'button[type="submit"]' : '[data-testid="send-button"]',
  )!;
  if (options.sendOutsideForm) document.body.append(send);
  if (options.disabled) send.setAttribute("disabled", "");
  send.addEventListener("click", (event) => {
    event.preventDefault();
    clicks++;
    submitted = readEditor();
    submittedInTemporary = location.search === "?temporary-chat=true";
    const cached = options.cachedHistory ? main.innerHTML : "";
    main.innerHTML =
      cached +
      '<article data-testid="conversation-turn-new" data-turn="assistant">' +
      '<div data-testid="cot-v5-test"><div class="markdown">Private reasoning</div></div>' +
      '<div data-streaming-response-status="complete">Thought</div>' +
      (options.structured
        ? '<div class="markdown"><pre><code>{"title":"ready"}</code></pre></div>'
        : '<div class="markdown"><p>Final answer</p><p>Second line<button>Copy</button></p></div>') +
      (options.complete === false
        ? ""
        : '<button data-testid="copy-turn-action-button">Copy</button>') +
      "</article>";
    if (options.currentResponse)
      main.innerHTML =
        cached +
        `<div data-talvt-turn-state="${options.complete === false ? "streaming" : "complete"}">` +
        "<div>User prompt must not appear in the answer</div>" +
        '<div data-testid="cot-v5-test"><p>Private reasoning</p></div>' +
        '<div data-content-search-unit-key="fallback-turn-0:2:assistant">' +
        '<div data-markdown-text-style="assistant-message">' +
        '<div data-dil-source-message-id="response" data-markdown-copy="contents">' +
        '<div data-d-inline-reveal data-dil-message-id="response">' +
        (options.renderFailed
          ? '<div role="status" data-dil-render-failed>This response couldn’t load</div>'
          : options.responseText ? '<p>' + options.responseText + '</p>' : options.structured
          ? '<pre><code>{"title":"ready"}</code></pre>'
          : '<p data-d-component="text">Final answer</p><p>Second line</p>') +
        "</div></div></div></div>" +
        '<button aria-label="Копировать">Copy</button><button aria-label="Сгенерировать ответ заново">Regenerate</button></div>';
  });
  document.createRange = (() => ({ selectNodeContents() {} })) as never;
  document.execCommand = ((_command: string, _show: boolean, value: string) => {
    writeEditor(options.corruptInput ? value.slice(0, -2) : value);
    return true;
  }) as never;
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const globals = {
    document,
    location,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    Element: window.Element,
    Node: window.Node,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    InputEvent: window.Event,
    AbortController,
    Symbol,
    Map,
    Set,
    Date: Clock,
    __name: (fn: unknown) => fn,
    setTimeout(fn: () => void, ms: number) {
      return setImmediate(() => {
        now += ms;
        fn();
      });
    },
    clearTimeout: clearImmediate,
  };
  const page = {
    signal: controller.signal,
    evaluate: async (fn: Function, input: unknown) =>
      runInNewContext("(" + fn.toString() + ")(input)", { ...globals, input }),
    delay: async (ms: number) =>
      new Promise<void>((resolve) =>
        setImmediate(() => {
          now += ms;
          resolve();
        }),
      ),
    waitFor: CrxPage.prototype.waitFor,
    locator: (selector: string) => ({
      fill: async (value: string) =>
        writeEditor(options.corruptInput ? value.slice(0, -2) : value),
      click: async () => {
        if (selector.includes("create-new-chat-button"))
          document.querySelector("a")!.click();
        else if (selector.includes("temporary-chat-button")) {
          await page.waitFor(async () => document.querySelector('[data-testid="temporary-chat-button"]'));
          (temporaryButton as HTMLElement).click();
        }
        else {
          assert.ok(document.querySelectorAll(selector).length, `Send selector must match the real DOM: ${selector}`);
          await page.waitFor(async () => !send.hasAttribute("disabled"));
          (send as HTMLElement).click();
        }
      },
    }),
  };
  return {
    run: async (structured = false, timeout = 10000) => {
      try {
        return await runChatGptUi(
          page as never,
          options.prompt ?? "Hello",
          structured,
          timeout,
        );
      } catch (error) {
        if ((error as Error).name === "AbortError")
          throw Object.assign(Error("Cancelled"), { code: "cancelled" });
        throw error;
      }
    },
    abort: () => controller.abort(),
    stats: () => ({ clicks, newChats, submitted }),
    temporaryStats: () => ({ temporaryClicks, submittedInTemporary }),
  };
}
test("ChatGPT enables temporary chat before submitting once", async () => {
  const f = fixture({ currentComposer: true });
  await f.run();
  assert.equal(f.stats().clicks, 1);
  assert.deepEqual(f.temporaryStats(), { temporaryClicks: 1, submittedInTemporary: true });
});

test("ChatGPT does not toggle off an already enabled temporary chat", async () => {
  const f = fixture({ temporary: true });
  await f.run();
  assert.deepEqual(f.temporaryStats(), { temporaryClicks: 0, submittedInTemporary: true });
});

test("ChatGPT re-enables temporary mode after New chat resets it", async () => {
  const f = fixture({ history: true, temporary: true });
  await f.run();
  assert.equal(f.stats().newChats, 1);
  assert.deepEqual(f.temporaryStats(), { temporaryClicks: 1, submittedInTemporary: true });
});

for (const options of [{ temporaryUnavailable: true }, { temporaryDoesNotActivate: true }])
  test("ChatGPT never falls back to a normal chat when temporary mode is unavailable", async () => {
    const f = fixture(options);
    await assert.rejects(f.run(), { code: "CHATGPT_UI_NOT_READY", stage: "prepare" });
    assert.equal(f.stats().clicks, 0);
  });
for (const textarea of [false, true])
  test("ChatGPT UI sends once, opens a new chat and excludes old answers/reasoning", async () => {
    const f = fixture({ history: true, textarea });
    assert.equal((await f.run()).text, "Final answer\n\nSecond line");
    assert.deepEqual(f.stats(), { clicks: 1, newChats: 1, submitted: "Hello" });
  });

test("ChatGPT current ProseMirror composer uses the form submit button without legacy test ids", async () => {
  const f = fixture({ currentComposer: true, history: true });
  assert.equal((await f.run()).text, "Final answer\n\nSecond line");
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 1, submitted: "Hello" });
});

test("ChatGPT Send is found when the native button is outside the composer form", async () => {
  const f = fixture({ sendOutsideForm: true });
  assert.equal((await f.run()).text, "Final answer\n\nSecond line");
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT current disabled submit never sends", async () => {
  const f = fixture({ currentComposer: true, disabled: true });
  await assert.rejects(f.run(false, 1000), {
    code: "CHATGPT_UI_NOT_READY", stage: "send",
  });
  assert.equal(f.stats().clicks, 0);
});

test("ChatGPT New chat becomes ready when old history and composer remain mounted but invisible", async () => {
  const f = fixture({
    history: true,
    currentComposer: true,
    currentResponse: true,
    cachedHistory: true,
    cachedComposer: true,
  });
  assert.equal((await f.run()).text, "Final answer\n\nSecond line");
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 1, submitted: "Hello" });
});

test("ChatGPT ignores hidden cached history on the home page without clicking New chat again", async () => {
  const f = fixture({
    currentComposer: true,
    currentResponse: true,
    cachedHistory: true,
    cachedComposer: true,
  });
  assert.equal((await f.run()).text, "Final answer\n\nSecond line");
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 0, submitted: "Hello" });
});

test("ChatGPT current DIL response completes without legacy turn/test ids and excludes the user prompt and toolbar", async () => {
  const f = fixture({ currentComposer: true, currentResponse: true });
  assert.equal((await f.run()).text, "Final answer\n\nSecond line");
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT Free DIL render failure is an error, never a successful answer or another Send", async () => {
  const f = fixture({ currentComposer: true, currentResponse: true, renderFailed: true });
  await assert.rejects(f.run(), {
    code: "CHATGPT_UI_ERROR", stage: "response",
    message: /could not render the response/,
  });
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT may legitimately quote the failure text without a native failure marker", async () => {
  const f = fixture({ currentResponse: true, responseText: "This response couldn’t load" });
  assert.equal((await f.run()).text, "This response couldn’t load");
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT current streaming turn never completes merely because its text is stable or Copy is present", async () => {
  const f = fixture({ currentResponse: true, complete: false });
  await assert.rejects(f.run(false, 3000), {
    code: "CHATGPT_RESPONSE_TIMEOUT",
  });
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT current structured response reads the assistant JSON without actions", async () => {
  const f = fixture({ currentResponse: true, structured: true });
  assert.equal((await f.run(true)).text, '{"title":"ready"}');
  assert.equal(f.stats().clicks, 1);
});

test("ChatGPT preserves multiline ProseMirror input including blank lines without comparing layout innerText", async () => {
  const prompt = "[user]\nFirst line\n\nSecond line <literal> 😀";
  const f = fixture({ currentComposer: true, prompt });
  await f.run();
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 0, submitted: prompt });
});

test("ChatGPT replaces the persisted draft after New chat rather than waiting for the site to clear it", async () => {
  const f = fixture({
    currentComposer: true,
    history: true,
    draft: "[user]\nhi",
    keepDraftOnNewChat: true,
  });
  await f.run();
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 1, submitted: "Hello" });
});

test("ChatGPT replaces a home-page draft without unnecessary navigation", async () => {
  const f = fixture({ currentComposer: true, draft: "old test" });
  await f.run();
  assert.deepEqual(f.stats(), { clicks: 1, newChats: 0, submitted: "Hello" });
});

test("ChatGPT reads native mixed text/DIV multiline input without losing its first line", () => {
  const { window } = parseHTML(
    '<html><body><form><div id="prompt-textarea" contenteditable="true">First line<div><br></div><div>Second &lt;literal&gt; 😀</div></div></form></body></html>',
  );
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    value: () => [{}],
  });
  const result = runInNewContext(
    "(" + readChatGptState.toString() + ")(input)",
    {
      document: window.document,
      location: { origin: "https://chatgpt.com", pathname: "/" },
      Element: window.Element,
      Node: window.Node,
      HTMLTextAreaElement: window.HTMLTextAreaElement,
      input: {
        composerSelector: "#prompt-textarea",
        turnSelector: "article",
        structured: false,
      },
      __name: (fn: unknown) => fn,
    },
  );
  assert.equal(result.prompt, "First line\n\nSecond <literal> 😀");
});

test("ChatGPT still rejects a genuinely truncated prompt before Send", async () => {
  const f = fixture({
    currentComposer: true,
    prompt: "Preserve all of this",
    corruptInput: true,
  });
  await assert.rejects(f.run(), { code: "CHATGPT_PROMPT_MISMATCH" });
  assert.equal(f.stats().clicks, 0);
});
test("ChatGPT structured UI response returns code content without its toolbar", async () => {
  const f = fixture({ structured: true });
  assert.equal((await f.run(true)).text, '{"title":"ready"}');
  assert.equal(f.stats().clicks, 1);
});
test("ChatGPT partial response times out without another Send", async () => {
  const f = fixture({ complete: false });
  await assert.rejects(f.run(false, 1000), {
    code: "CHATGPT_RESPONSE_TIMEOUT",
  });
  assert.equal(f.stats().clicks, 1);
});
test("ChatGPT cancellation before Send does not submit later", async () => {
  const f = fixture({ disabled: true });
  const pending = f.run();
  await new Promise((resolve) => setImmediate(resolve));
  f.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(f.stats().clicks, 0);
});
test("ChatGPT session returns only the account identity and rejects guests", async () => {
  let user: unknown = { email: "Owner@Example.Test" };
  const page = {
    location: { origin: "https://chatgpt.com" },
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({ user, accessToken: "secret-stays-in-page" }),
    }),
  };
  const run = () =>
    runInNewContext("(" + detectChatGptAccount.toString() + ")()", {
      ...page,
      __name: (fn: unknown) => fn,
    });
  assert.deepEqual(JSON.parse(JSON.stringify(await run())), {
    accountSubject: "owner@example.test",
    accountTier: "unknown",
  });
  user = null;
  await assert.rejects(run(), /Sign in/);
});
test("ChatGPT keeps the shared text-only contract and cancellation never attaches Chrome", async () => {
  assert.equal(
    providerStatusSchema.parse({ id: "chatgpt_web", available: true }).id,
    "chatgpt_web",
  );
  const request = parseSDKRequest({
    kind: "text",
    options: {
      model: "chatgpt-web",
      messages: [{ role: "user", content: "Hello" }],
    },
  });
  assert.throws(() =>
    parseSDKRequest({
      kind: "image",
      options: { model: "chatgpt-web", prompt: "x" },
    }),
  );
  if (request.kind !== "text") throw Error("Expected text");
  const controller = new AbortController();
  controller.abort();
  let contexts = 0;
  await assert.rejects(
    generateChatGptText(
      request.options,
      controller.signal,
      async () => {
        contexts++;
        return { tabId: 1, accountSubject: "owner@example.test" };
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(contexts, 0);
});
