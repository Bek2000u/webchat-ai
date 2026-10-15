import assert from "node:assert/strict";
import test from "node:test";
import { MODELS, parseSDKRequest } from "../../src/shared/contracts.js";
import {
  runTextUi,
  temporaryChat,
  type TextUiDriver,
  type TextUiPage,
  type TextUiState,
} from "../../src/extension/providers/text.js";
import { GEMINI_DRIVER } from "../../src/extension/providers/gemini.js";
import { QWEN_DRIVER } from "../../src/extension/providers/qwen.js";
import { DEEPSEEK_DRIVER } from "../../src/extension/providers/deepseek.js";

function fixture(options: { history?: boolean; busy?: boolean; partial?: boolean; thinkingFails?: boolean; mismatch?: boolean; error?: boolean; temporaryFails?: boolean; losesTemporary?: boolean } = {}) {
  const controller = new AbortController(), actions: string[] = [];
  let clock = 0, sent = false;
  const state: TextUiState = { origin: "https://fixture.test", path: options.history ? "/c/old" : "/", composer: true,
    prompt: "old draft", history: !!options.history, busy: !!options.busy, error: false, text: "", complete: false };
  const driver: TextUiDriver = {
    id: "FIXTURE", origin: state.origin, composer: "editor", send: "send", newChat: "new",
    isConversation: path => path.startsWith("/c/"),
    read: async () => {
      if (sent) { state.text = "Final answer"; state.complete = !options.partial; state.error = !!options.error; }
      return { ...state };
    },
    thinking: async (_page, mode) => { actions.push(`thinking:${mode}`); if (options.thinkingFails) throw Error("Account does not support this mode"); },
  };
  const page = {
    signal: controller.signal,
    goto: async (url: string) => { actions.push(`goto:${url}`); state.path = "/"; state.history = false; },
    locator: (selector: string) => ({
      fill: async (value: string) => { controller.signal.throwIfAborted(); actions.push("fill"); state.prompt = options.mismatch ? "truncated" : value; if(options.losesTemporary)state.temporary=false; },
      click: async () => {
        controller.signal.throwIfAborted(); actions.push(selector);
        if (selector === "new") { state.path = "/"; state.history = false; }
        if (selector === "temporary" && !options.temporaryFails) state.temporary = true;
        if (selector === "send") sent = true;
      },
    }),
    waitFor: async (read: () => Promise<unknown>, timeout = 30000) => {
      const end = clock + timeout;
      while (clock <= end) {
        controller.signal.throwIfAborted(); const value = await read(); if (value) return value;
        clock += 100;
        // Keep the actual runner's completion settling deterministic.
        await new Promise(resolve => setTimeout(resolve, options.partial ? 0 : 100));
      }
      throw Object.assign(Error("Timeout"), { code: "BROWSER_UI_TIMEOUT" });
    },
  } as unknown as TextUiPage;
  return { driver, page, actions, controller, state, run: (thinking: "default" | "fast" | "deep" = "default") => runTextUi(page, driver, "Full prompt", false, thinking, 2200) };
}

test("shared temporary hook enables once and verifies the native marker before Send", async () => {
  const f = fixture(); Object.assign(f.driver, temporaryChat("FIXTURE", "temporary"));
  await f.run();
  assert.deepEqual(f.actions, ["temporary", "fill", "send"]);
  await f.driver.prepare!(f.page, () => f.driver.read(f.page, false));
  assert.equal(f.actions.filter(a => a === "temporary").length, 1);
});

test("Gemini resets its native page before a fresh temporary chat", async () => {
  const f = fixture({ history: true });
  f.driver.newChatUrl = GEMINI_DRIVER.newChatUrl;
  await f.run();
  assert.deepEqual(f.actions, ["goto:https://gemini.google.com/app", "fill", "send"]);
});
test("temporary confirmation failure never fills or sends an ordinary chat", async () => {
  const f = fixture({ temporaryFails: true, partial: true }); Object.assign(f.driver, temporaryChat("FIXTURE", "temporary"));
  await assert.rejects(f.run(), { code: "FIXTURE_UI_NOT_READY", stage: "prepare" });
  assert.deepEqual(f.actions, ["temporary"]);
});
test("temporary mode lost during preparation cannot pass validation or Send", async () => {
  const f = fixture({ losesTemporary: true }); Object.assign(f.driver, temporaryChat("FIXTURE", "temporary"));
  await assert.rejects(f.run(), { code: "FIXTURE_TEMPORARY_CHAT_UNAVAILABLE", stage: "prompt" });
  assert.deepEqual(f.actions, ["temporary", "fill"]);
});
for (const driver of [GEMINI_DRIVER, QWEN_DRIVER]) test(`${driver.id} requires native temporary chat`, () => {
  assert.equal(typeof driver.prepare, "function");
  assert.throws(() => driver.validate!({ temporary: false } as TextUiState), { code: `${driver.id}_TEMPORARY_CHAT_UNAVAILABLE` });
});

test("the text catalog exposes one vendor-default route per LLM, no version aliases", () => {
  assert.deepEqual(MODELS.filter(m => m.kind === "text" && m.providerId).map(m => m.id), ["chatgpt-web", "gemini-web", "qwen-web", "deepseek-web"]);
  assert.equal(MODELS.find(m => m.id === "auto")?.providerId, undefined);
});
for (const thinking of ["default", "fast", "deep"] as const) {
  test(`shared UI runner: ${thinking}, new chat and exactly one Send`, async () => {
    const f = fixture({ history: true });
    assert.deepEqual(await f.run(thinking), { text: "Final answer" });
    assert.deepEqual(f.actions, thinking === "default" ? ["new", "fill", "send"] : ["new", `thinking:${thinking}`, "fill", "send"]);
  });
  test(`SDK accepts the common ${thinking} thinking option`, () => {
    assert.equal(parseSDKRequest({ kind: "text", options: { model: "gemini-web", messages: [{ role: "user", content: "Hi" }], modelOptions: { thinking } } }).kind, "text");
  });
}
test("SDK rejects invalid thinking rather than silently ignoring it", () => {
  assert.throws(() => parseSDKRequest({ kind: "text", options: { model: "qwen-web", messages: [{ role: "user", content: "Hi" }], modelOptions: { thinking: true } } }));
});
test("an unavailable thinking mode never fills or submits and never switches models", async () => {
  const f = fixture({ thinkingFails: true });
  await assert.rejects(f.run("deep"), { code: "FIXTURE_THINKING_UNAVAILABLE", stage: "thinking" });
  assert.deepEqual(f.actions, ["thinking:deep"]);
});
test("a changed/truncated composer never submits", async () => {
  const f = fixture({ mismatch: true });
  await assert.rejects(f.run(), { code: "FIXTURE_PROMPT_MISMATCH", stage: "prompt" });
  assert.deepEqual(f.actions, ["fill"]);
});
test("busy and aborted UI never submit", async () => {
  const f = fixture({ busy: true });
  await assert.rejects(f.run(), { code: "FIXTURE_UI_BUSY" });
  assert.deepEqual(f.actions, []);
  const cancelled = fixture(); cancelled.controller.abort();
  await assert.rejects(cancelled.run(), { name: "AbortError" });
  assert.deepEqual(cancelled.actions, []);
});
test("partial output and provider errors never replay Send", async () => {
  for (const error of [false, true]) {
    const f = fixture({ partial: !error, error });
    await assert.rejects(f.run(), { code: error ? "FIXTURE_UI_ERROR" : "FIXTURE_RESPONSE_TIMEOUT", stage: "response", outcome: "unknown", retryable: true });
    assert.equal(f.actions.filter(action => action === "send").length, 1);
  }
});

test("a pre-Send composer mismatch carries a safe preparation retry hint", async () => {
  const f = fixture({ mismatch: true });
  await assert.rejects(f.run(), { code: "FIXTURE_PROMPT_MISMATCH", outcome: "not_submitted", retryable: true });
  assert.equal(f.actions.includes("send"), false);
});
for (const driver of [GEMINI_DRIVER, QWEN_DRIVER, DEEPSEEK_DRIVER])
  test(`${driver.id} exposes site selectors over the same runner without a generation API`, () => {
    assert.ok(driver.composer && driver.send && driver.newChat);
    assert.equal(typeof driver.thinking, "function");
  });
