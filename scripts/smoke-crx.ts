import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, type BrowserContext } from "playwright";

/// <reference types="chrome" />
/** Real Chromium + MV3 fixture; intercepts ALL web traffic. No provider requests. */

const temporary = await mkdtemp(join(tmpdir(), "webchat-ai-crx-smoke-"));
const extension = join(temporary, "extension");
await mkdir(extension);
await writeFile(
  join(extension, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "Isolated CRX fixture",
    version: "1.0.0",
    permissions: ["debugger", "tabs"],
    background: { service_worker: "background.js", type: "module" },
  }),
);
await build({
  stdin: {
    contents: `
  import {withCrxPage,PLAYWRIGHT_VERSION} from './dist/playwright/index.js';
  import {CHATGPT_DRIVER} from './src/extension/providers/chatgpt.ts';
  import {GEMINI_DRIVER} from './src/extension/providers/gemini.ts';
  import {QWEN_DRIVER} from './src/extension/providers/qwen.ts';
  import {DEEPSEEK_DRIVER} from './src/extension/providers/deepseek.ts';
  import {runTextUi} from './src/extension/providers/text.ts';
  import {prepareGoogleVidsUi} from './src/extension/providers/google-vids/ui.ts';
  globalThis.prepareVidsUiFixture = tabId => withCrxPage(tabId, AbortSignal.timeout(10000), prepareGoogleVidsUi);
  const drivers={chatgpt:CHATGPT_DRIVER,gemini:GEMINI_DRIVER,qwen:QWEN_DRIVER,deepseek:DEEPSEEK_DRIVER};
  globalThis.runCrxFixture = async (tabId, options = {}) => {
    const controller = new AbortController();
    const timers = [];
    let readContextLossInjected = false;
    if (options.abortMs) timers.push(setTimeout(() => controller.abort(), options.abortMs));
    try {
      const result = await withCrxPage(tabId, controller.signal, async page => {
        if (options.loseReadContextAfterSend) {
          const send = page.transport.send.bind(page.transport);
          page.transport.send = async (method, params) => {
            if (!readContextLossInjected && method === 'Runtime.evaluate' && params?.expression?.includes('function readTextUiDom')) {
              const submitted = await send('Runtime.evaluate', {expression:'Number(document.body.dataset.submits || 0)',contextId:params.contextId,returnByValue:true});
              if (submitted.result.value > 0) {
                readContextLossInjected = true;
                throw Error('Cannot find context with specified id');
              }
            }
            return send(method, params);
          };
        }
        if (options.detachAfterSend) {
          const baseline = await page.evaluate(() => Number(document.body.dataset.submits || 0), undefined);
          void (async () => {
            await page.waitFor(() => page.evaluate(before => Number(document.body.dataset.submits || 0) > before, baseline));
            await chrome.debugger.detach({tabId});
          })().catch(() => {});
        }
        return runTextUi(page, drivers[options.provider || 'chatgpt'], options.prompt || 'Fixture prompt', !!options.structured, options.thinking || 'default', options.timeout || 10000);
      });
      return {ok:true, ...result, readContextLossInjected, version:PLAYWRIGHT_VERSION};
    } catch(error) {return {ok:false, code:error.code, name:error.name, message:error.message};}
    finally {for(const timer of timers) clearTimeout(timer); controller.abort();}
  };
`,
    resolveDir: resolve("."),
    sourcefile: "crx-fixture.ts",
  },
  outfile: join(extension, "background.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
});

const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="fixture-new-chat" type="button"><span>Новый чат</span></button>
<button type="button" aria-label="Временный чат" data-testid="temporary-chat-button"></button>
<button type="button" id="effort" aria-label="Choose model ChatGPT">Instant</button>
<button type="button" id="free-think" aria-pressed="false" hidden>Think</button>
<div role="menu" id="effort-menu" hidden><div role="menuitem" tabindex="-1" data-reasoning-slider="true" aria-keyshortcuts="ArrowLeft ArrowRight"><span data-orientation="horizontal" aria-disabled="false" style="display:block;width:150px;height:30px"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0" aria-hidden="true"></span></span></div><button role="menuitemradio" onclick="fixtureStats.modelSelections++">Do not select a model</button></div>
<form data-chatgpt-composer><div data-composer-markdown role="textbox" contenteditable="true" style="min-height:80px;width:500px">Persisted draft</div>
<button type="button">Tools</button><button type="submit" disabled>Send</button></form>
<main><article data-talvt-turn-state="complete"><div data-markdown-text-style="assistant-message">Old answer</div></article></main>
<script>
window.fixtureStats={submits:0,newChats:0,trusted:[],prompts:[],temporary:[],temporaryEnables:0,modelSelections:0,thinking:[]};
const freeVariant=location.pathname.includes('free-fixture');document.querySelector('#effort').hidden=freeVariant;document.querySelector('#free-think').hidden=!freeVariant;
document.querySelector('#free-think').onclick=e=>{e.currentTarget.setAttribute('aria-pressed',String(e.currentTarget.getAttribute('aria-pressed')!=='true'));};
document.querySelector('#effort').onclick=()=>document.querySelector('#effort-menu').hidden=false;
document.querySelector('[data-reasoning-slider]').onkeydown=event=>{if(document.activeElement!==event.currentTarget)return;const direction=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;if(direction){event.preventDefault();const slider=document.querySelector('[role=slider]');slider.setAttribute('aria-valuenow',String(Math.max(0,Math.min(4,Number(slider.getAttribute('aria-valuenow'))+direction))));}};
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelector('#effort-menu').hidden=true;});
const editor=document.querySelector('[contenteditable]'), send=document.querySelector('button[type=submit]');
document.querySelector('#fixture-new-chat').onclick=event=>{event.preventDefault();fixtureStats.newChats++;history.pushState(null,'','/');document.querySelectorAll('main article').forEach(n=>n.hidden=true);};
document.querySelector('[data-testid=temporary-chat-button]').onclick=()=>{fixtureStats.temporaryEnables++;history.replaceState(null,'','/?temporary-chat=true');};
editor.addEventListener('input',()=>{if(!window.lockSend)send.disabled=false;});
document.querySelector('form').onsubmit=event=>{
 event.preventDefault(); fixtureStats.submits++;document.body.dataset.submits=String(fixtureStats.submits);fixtureStats.trusted.push(event.isTrusted);fixtureStats.prompts.push(editor.innerText);
 fixtureStats.temporary.push(new URLSearchParams(location.search).get('temporary-chat')==='true');
 fixtureStats.thinking.push(document.querySelector('#free-think').getAttribute('aria-pressed')==='true');
 const article=document.createElement('article');article.setAttribute('data-talvt-turn-state',window.fixturePartial?'streaming':'complete');
 article.innerHTML='<div>User prompt</div><div data-testid="cot-v5-test">Private reasoning</div><div data-markdown-text-style="assistant-message">'+(window.fixtureRenderFailed?'<div role="status" data-dil-render-failed>This response couldn’t load</div>':window.fixtureStructured?'<pre><code>{"title":"ready"}</code></pre>':'<p>Fixture answer</p><p>Second line</p>')+'</div><button>Copy</button>';
 document.querySelector('main').append(article);
};
</script></body></html>`;

function textFixture(provider: "gemini" | "qwen" | "deepseek") {
  const markup = provider === "gemini" ? `
    <a href="/app" data-test-id="new-chat-button">New chat</a>
    <button type="button" id="temporary" aria-label="Temporary chat">Temporary</button>
    <button type="button" id="mode" aria-label="Open mode picker, currently Gemini Auto">Vendor model</button>
    <div role="menu" id="modes" hidden><button role="menuitem" id="thinking">Thinking level</button><button role="menuitem" id="model">Do not select model</button></div>
    <div role="menu" id="levels" hidden><button role="menuitem" data-level="fast">Low</button><button role="menuitem" data-level="deep">High</button></div>
    <form><rich-textarea><div contenteditable="true" role="textbox" style="width:400px;min-height:60px"></div></rich-textarea><button type="submit" aria-label="Send message" disabled>Send</button></form>`
    : provider === "qwen" ? `
    <div id="new" role="button" tabindex="0" aria-label="New Chat"><span>New Chat</span></div><button id="model">Do not select model</button>
    <button type="button" id="temporary" class="temporary-chat-entry" aria-label="Temporary Chat" aria-pressed="false">Temporary</button>
    <div class="qwen-thinking-selector"><div class="qwen-chat-v2-dropdown-menu-trigger"><span id="thinking-label">Auto</span></div></div>
    <div role="menu" id="levels" hidden><button role="menuitem" data-level="fast">Fast</button><button role="menuitem" data-level="deep">Thinking</button></div>
    <form><textarea class="message-input-textarea"></textarea><button type="submit" class="send-button" aria-label="Send" disabled>Send</button></form><div class="message-input-right-button-send"><button aria-label="Voice mode">Voice</button></div>`
    : `<div style="display:none" tabindex="0"><span>New chat</span></div><div id="new" role="button" tabindex="0"><svg width="16" height="16"><path d="M8 0.599609C3 0 0 3 0 8"></path></svg></div><button id="model">Do not select model</button>
    <div role="button" class="ds-button--warning ds-button--circle" onclick="fixtureStats.oldRetries++">Retry old failure</div>
    <button type="button" aria-pressed="false">DeepThink</button><textarea name="search"></textarea><div id="send" role="button" class="ds-button--primary ds-button--circle ds-button--disabled" tabindex="0">Send</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><chat-window>${markup}<main></main></chat-window><script>
    const provider=${JSON.stringify(provider)};
    window.fixtureStats=(provider==='gemini'?JSON.parse(sessionStorage.getItem('fixtureStats')||'null'):null)||{submits:0,newChats:0,thinking:[],modelSelections:0,oldRetries:0,temporary:[],temporaryEnables:0}; let mode='vendor-default',temporary=false;
    if(provider==='gemini')addEventListener('pagehide',()=>{fixtureStats.newChats++;sessionStorage.setItem('fixtureStats',JSON.stringify(fixtureStats));});
    const editor=document.querySelector('textarea,[contenteditable]'),send=document.querySelector('button[type=submit],#send');
    const fresh=document.querySelector('a,#new');
    const temporaryButton=document.querySelector('#temporary');
    const showTemporary=()=>{document.querySelector('chat-window').classList.toggle('is-temporary-chat',temporary);if(temporaryButton)temporaryButton.setAttribute('aria-pressed',String(temporary));if(provider==='qwen')fresh.hidden=temporary;};
    const reset=()=>{fixtureStats.newChats++;history.pushState(null,'',provider==='gemini'?'/app':'/');document.querySelector('main').replaceChildren();temporary=false;showTemporary();};
    fresh.onclick=e=>{e.preventDefault();reset();};
    if(temporaryButton)temporaryButton.onclick=()=>{if(temporary){reset();}else{temporary=true;fixtureStats.temporaryEnables++;if(provider==='qwen')history.replaceState(null,'','/?temporary-chat=true');showTemporary();}};
    document.querySelector('#model').onclick=()=>fixtureStats.modelSelections++;
    editor.addEventListener('input',()=>{send.disabled=false;send.classList.remove('ds-button--disabled');});
    const submit=e=>{e.preventDefault();fixtureStats.submits++;document.body.dataset.submits=String(fixtureStats.submits);fixtureStats.thinking.push(mode);fixtureStats.temporary.push(temporary);
      document.querySelector('main').innerHTML=provider==='gemini'?'<model-response><message-content>Fixture answer</message-content><button aria-label="Copy response">Copy</button></model-response>':provider==='qwen'?'<div class="response-message-content"><div class="qwen-markdown">Fixture answer</div></div>':'<div class="ds-markdown">Fixture answer</div>';
      send.classList.add('ds-button--disabled');
    };
    if(provider==='deepseek') { send.onclick=submit;document.querySelector('[aria-pressed]').onclick=e=>{const n=e.currentTarget;const enabled=n.getAttribute('aria-pressed')!=='true';n.setAttribute('aria-pressed',String(enabled));mode=enabled?'deep':'fast';}; }
    else {document.querySelector('form').onsubmit=submit;
      document.querySelectorAll('[data-level]').forEach(n=>n.onclick=()=>{mode=n.dataset.level;document.querySelectorAll('[data-level]').forEach(v=>v.classList.toggle('selected',v===n));document.querySelector('#levels').hidden=true;if(provider==='gemini')document.querySelector('#modes').hidden=true;else document.querySelector('#thinking-label').textContent=n.textContent;});
      if(provider==='gemini') {document.querySelector('#mode').onclick=()=>document.querySelector('#modes').hidden=false;document.querySelector('#thinking').onclick=()=>document.querySelector('#levels').hidden=false;}
      else document.querySelector('.qwen-chat-v2-dropdown-menu-trigger').onclick=()=>document.querySelector('#levels').hidden=false;
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.querySelector('#levels').hidden=true;if(provider==='gemini')document.querySelector('#modes').hidden=true;}});
    }
  </script></body></html>`;
}
let context: BrowserContext | undefined;
try {
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    ...(process.env.CRX_SMOKE_BROWSER_PATH
      ? { executablePath: process.env.CRX_SMOKE_BROWSER_PATH }
      : {}),
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
    ],
  });
  let requests = 0;
  await context.route("**/*", (route) => {
    requests++;
    if (route.request().url() === "https://fixture.invalid/foreground")
      return route.fulfill({ contentType: "text/html", body: '<textarea aria-label="Playground draft"></textarea>' });
    if (route.request().url().startsWith("https://chatgpt.com/"))
      return route.fulfill({ contentType: "text/html", body: fixture });
    if (route.request().url().startsWith("https://docs.google.com/videos/"))
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html><head><meta charset="utf-8"></head><body>
        <div role="dialog"><p>Пустой файл Vids</p><button aria-label="Закрыть" onclick="this.parentElement.remove()">×</button></div>
        <button aria-label="Закадровая речь" onclick="window.voiceClicks++;document.querySelector('#panel').hidden=false">Voiceover</button>
        <div id="panel" hidden><button role="tab">Эта сцена</button><button role="tab">Все сцены</button><button onclick="window.generations++">Generate</button></div>
        <textarea>Keep original script</textarea><script>window.voiceClicks=0;window.generations=0;</script></body></html>` });
    for (const [provider, origin] of [["gemini", "https://gemini.google.com/"], ["qwen", "https://chat.qwen.ai/"], ["deepseek", "https://chat.deepseek.com/"]] as const)
      if (route.request().url().startsWith(origin)) return route.fulfill({ contentType: "text/html", body: textFixture(provider) });
    return route.abort();
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const vids = await context.newPage();
  await vids.goto("https://docs.google.com/videos/d/fixture/edit");
  const [vidsTarget] = await worker.evaluate(() => chrome.tabs.query({ url: "https://docs.google.com/videos/*" }));
  for (let n = 0; n < 2; n++) {
    try { await worker.evaluate(async tabId => (globalThis as any).prepareVidsUiFixture(tabId), vidsTarget.id!); }
    catch (error) {
      console.error("Isolated Vids fixture state", await vids.evaluate(() => ({ welcome: !!document.querySelector('[role="dialog"]'), panelHidden: (document.querySelector('#panel') as HTMLElement).hidden, clicks: (window as any).voiceClicks })));
      throw error;
    }
  }
  assert.deepEqual(await vids.evaluate(() => ({ welcome: !!document.querySelector('[role="dialog"]'), clicks: (window as any).voiceClicks, generations: (window as any).generations, script: document.querySelector('textarea')!.value })), { welcome: false, clicks: 1, generations: 0, script: "Keep original script" });
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/fixture");
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "https://chatgpt.com/c/fixture" }),
  );
  assert.ok(tab?.id, "The fixture tab must be visible to the extension");
  await page.waitForSelector("[contenteditable]");
  const run = (options: Record<string, unknown> = {}) =>
    worker.evaluate(
      async ({ tabId, options }) =>
        (globalThis as any).runCrxFixture(tabId, options),
      { tabId: tab.id!, options },
    );
  const stats = () => page.evaluate(() => (window as any).fixtureStats);
  const foreground = await context.newPage();
  await foreground.goto("https://fixture.invalid/foreground");
  await foreground.locator("textarea").fill("Untouched Playground draft");
  const first = await run({ prompt: "First line\n\nSecond <literal> 😀" });
  if (!first.ok)
    console.log(
      JSON.stringify({
        fixtureFailure: first,
        editor: await page
          .locator("[contenteditable]")
          .evaluate((node) => ({
            html: node.innerHTML,
            text: (node as HTMLElement).innerText,
          })),
        stats: await stats(),
      }),
    );
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.text, "Fixture answer\n\nSecond line");
  assert.equal(first.version, "1.64.1");
  assert.equal(await foreground.locator("textarea").inputValue(), "Untouched Playground draft");
  // The provider remains in the background: no activation assumptions and no
  // Input.* commands may affect the foreground editor.
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ active: true }))).some(item => item.id === tab.id), false);
  assert.deepEqual((await stats()).trusted, [true]);
  assert.equal((await stats()).submits, 1);
  await foreground.bringToFront();
  const second = await run();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await stats()).submits, 2);
  assert.deepEqual((await stats()).temporary, [true, true]);
  assert.equal((await stats()).temporaryEnables, 2);
  assert.equal((await stats()).newChats, 2);
  assert.equal(await foreground.locator("textarea").inputValue(), "Untouched Playground draft");
  await page.evaluate(() => {
    (window as any).fixtureStructured = true;
  });
  const structured = await run({ structured: true });
  assert.equal(structured.text, '{"title":"ready"}');
  assert.equal((await stats()).submits, 3);
  for (const thinking of ["fast", "deep"]) {
    const result = await run({ thinking });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(await page.locator('[role=slider]').getAttribute('aria-valuenow'), thinking === 'fast' ? '0' : '4');
  }
  assert.equal((await stats()).modelSelections, 0);
  await page.evaluate(() => {
    (window as any).fixturePartial = true;
  });
  const partial = await run({ timeout: 700 });
  assert.equal(
    partial.code,
    "CHATGPT_RESPONSE_TIMEOUT",
    JSON.stringify(partial),
  );
  assert.equal((await stats()).submits, 6);
  const disconnected = await run({ detachAfterSend: true });
  assert.equal(
    disconnected.code,
    "outcome_unknown",
    JSON.stringify(disconnected),
  );
  assert.equal((await stats()).submits, 7);
  await page.goto("https://chatgpt.com/c/fixture-abort");
  await page.evaluate(() => {
    (window as any).lockSend = true;
  });
  const aborted = await run({ abortMs: 700 });
  assert.equal(aborted.name, "AbortError", JSON.stringify(aborted));
  assert.equal((await stats()).submits, 0);
  const free = await context.newPage(); await free.goto("https://chatgpt.com/c/free-fixture");
  const [freeTarget] = await worker.evaluate(() => chrome.tabs.query({url:"https://chatgpt.com/c/free-fixture"}));
  for (const thinking of ["default","fast","deep"]) {
    const result = await worker.evaluate(async ({tabId,thinking}) => (globalThis as any).runCrxFixture(tabId,{thinking}), {tabId:freeTarget.id!,thinking});
    assert.equal(result.ok,true,JSON.stringify({thinking,result}));
  }
  const freeStats = await free.evaluate(()=>(window as any).fixtureStats);
  assert.deepEqual(freeStats.thinking,[false,false,true]);
  assert.deepEqual(freeStats.temporary,[true,true,true]);
  assert.equal(freeStats.submits,3); assert.equal(freeStats.modelSelections,0);
  await free.evaluate(() => { (window as any).fixtureRenderFailed = true; });
  const renderFailed = await worker.evaluate(async tabId => (globalThis as any).runCrxFixture(tabId), freeTarget.id!);
  assert.equal(renderFailed.ok, false, JSON.stringify(renderFailed));
  assert.equal(renderFailed.code, "CHATGPT_UI_ERROR");
  assert.equal(await free.evaluate(() => (window as any).fixtureStats.submits), 4);
  for (const [provider, url] of [["gemini", "https://gemini.google.com/app/fixture"], ["qwen", "https://chat.qwen.ai/c/fixture"], ["deepseek", "https://chat.deepseek.com/a/chat/s/fixture"]] as const) {
    const site = await context.newPage(); await site.goto(url);
    const [target] = await worker.evaluate(url => chrome.tabs.query({ url }), url);
    for (const thinking of ["default", "fast", "deep"]) {
      const result = await worker.evaluate(async ({tabId, provider, thinking}) => (globalThis as any).runCrxFixture(tabId, {provider, thinking, loseReadContextAfterSend:provider==='qwen'}), {tabId:target.id!,provider,thinking});
      assert.equal(result.ok, true, JSON.stringify({provider,thinking,result}));
      assert.equal(result.text, "Fixture answer");
      if (provider === "qwen") assert.equal(result.readContextLossInjected, true);
    }
    const actual = await site.evaluate(() => (window as any).fixtureStats);
    assert.equal(actual.submits, 3);
    assert.equal(actual.modelSelections, 0);
    assert.equal(actual.oldRetries, 0);
    if(provider!=='deepseek') {
      assert.deepEqual(actual.temporary,[true,true,true]);
      assert.equal(actual.temporaryEnables,3);
      assert.equal(actual.newChats,3);
    }
    assert.deepEqual(actual.thinking, ["vendor-default", provider === "deepseek" ? "vendor-default" : "fast", "deep"]);
  }
  console.log(
    JSON.stringify({
      status: "passed",
      browser: context.browser()?.version(),
      playwright: first.version,
      checks: [
        "Vids welcome dismissed and voiceover opened once without Generate or script edits",
        "background document-bound input preserves foreground textarea",
        "multiline prompt",
        "second request/new chat with nested label and no legacy test IDs",
        "temporary mode confirmed before every Send, re-enabled after New chat",
        "structured JSON",
        "partial timeout without replay",
        "debugger disconnect without replay",
        "abort before Send",
        "all four UI LLMs: default/fast/deep without model selection",
        "free ChatGPT: Think off/on and temporary, without paid model picker",
        "free ChatGPT native render failure returns error, never success or another Send",
        "Qwen stale DOM read context reacquired without resubmission",
        "English free Gemini Auto picker retains current model",
      ],
      fixtureRequests: requests,
      realProviderRequests: 0,
    }),
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
