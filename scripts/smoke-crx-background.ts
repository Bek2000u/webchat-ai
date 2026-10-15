import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium, type Browser } from "playwright";

// A real Chromium/MV3 regression, with NO vendor calls. Unlike ordinary
// Playwright contexts, connectOverCDP(noDefaults) does not silently supply the
// missing focus override and mask our old transport's background-tab bug.
const temporary = await mkdtemp(join(tmpdir(), "webchat-ai-background-crx-"));
const extension = join(temporary, "extension"), profile = join(temporary, "profile");
await mkdir(extension); await mkdir(profile);
await writeFile(join(extension, "manifest.json"), JSON.stringify({
  manifest_version: 3, name: "Background CRX regression", version: "1.0.0",
  permissions: ["tabs", "debugger"], host_permissions: ["https://gemini.google.com/*"],
  background: { service_worker: "background.js", type: "module" },
}));
await build({
  stdin: { contents: `
    import {CrxPage} from './src/extension/playwright/index.ts';
    import {runTextUi} from './src/extension/providers/text.ts';
    import {GEMINI_DRIVER} from './src/extension/providers/gemini.ts';
    globalThis.runBackground = async (tabId, legacy) => {
      const page = new CrxPage(tabId, AbortSignal.timeout(10000));
      const send = page.transport.send.bind(page.transport);
      if(legacy) page.transport.send = (method, params) => method === 'Emulation.setFocusEmulationEnabled' ? Promise.resolve({}) : send(method, params);
      try {
        await page.attach();
        return {ok:true,...await runTextUi(page,GEMINI_DRIVER,'Background smoke',false,'default',legacy?700:6000)};
      } catch(error) {return {ok:false,code:error.code,message:error.message};}
      finally {await page.detach();}
    };
  `, resolveDir: resolve("."), sourcefile: "background-regression.ts" },
  outfile: join(extension, "background.js"), bundle: true, format: "esm", platform: "browser", target: "chrome116",
});
const child = spawn(chromium.executablePath(), [
  "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
  "--disable-features=DisableLoadExtensionCommandLineSwitch", "about:blank",
], { windowsHide: true, stdio: "ignore" });
let browser: Browser | undefined;
try {
  let port = "";
  const deadline = Date.now() + 15000;
  while (!port) {
    if (child.exitCode !== null) throw Error("Fixture Chromium exited before startup");
    if (Date.now() > deadline) throw Error("Fixture Chromium debugging port unavailable");
    port = await readFile(join(profile, "DevToolsActivePort"), "utf8").then(value => value.split("\n")[0]).catch(() => "");
    if (!port) await new Promise(done => setTimeout(done, 100));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const context = browser.contexts()[0];
  const fixture = `<!doctype html><html><body><chat-window>
    <button aria-label="Temporary chat" onclick="document.querySelector('chat-window').classList.add('is-temporary-chat')">Temporary</button>
    <rich-textarea><div contenteditable="true" role="textbox" style="width:400px;min-height:80px"></div></rich-textarea>
    <button aria-label="Send message" onclick="window.submitted++;window.pending=true;start()">Send</button>
    <main></main></chat-window><script>
    window.submitted=0;window.started=0;window.pending=false;
    window.loads=Number(sessionStorage.loads||0)+1;sessionStorage.loads=String(window.loads);
    function start(){if(!window.pending||document.hidden||!document.hasFocus())return;window.pending=false;window.started++;
      document.querySelector('main').innerHTML='<model-response><message-content>SMOKE_OK</message-content><button aria-label="Copy">Copy</button></model-response>';
    }
    addEventListener('visibilitychange',start);addEventListener('focus',start);
    </script></body></html>`;
  await context.route("**/*", route => route.fulfill({ contentType: "text/html", body: route.request().url().startsWith("https://gemini.google.com/") ? fixture : '<textarea aria-label="User draft">Untouched draft</textarea>' }));
  let worker: import("playwright").Worker | undefined;
  for (let check = 0; !worker && check < 100; check++) {
    for (const candidate of context.serviceWorkers()) {
      if (await candidate.evaluate(() => chrome.runtime.getManifest().name).catch(() => "") === "Background CRX regression") worker = candidate;
    }
    if (!worker) await new Promise(done => setTimeout(done, 100));
  }
  assert(worker, "Regression extension service worker unavailable");
  const target = await context.newPage(); await target.goto("https://gemini.google.com/app");
  const foreground = await context.newPage(); await foreground.goto("https://fixture.invalid/");
  const tabs = await worker.evaluate(async () => {
    for (let check = 0; check < 30; check++) {
      const all = await chrome.tabs.query({});
      const tab = all.find(t => t.url?.startsWith("https://gemini.google.com/"));
      const front = all.find(t => t.url?.startsWith("https://fixture.invalid/"));
      if (tab && front) return { tab, front };
      if (check === 29) throw Error(JSON.stringify({ tabs:all.map(t => ({id:t.id,url:t.url,pendingUrl:t.pendingUrl})),permissions:await chrome.permissions.getAll(),manifest:chrome.runtime.getManifest().permissions }));
      await new Promise(done => setTimeout(done, 100));
    }
    throw Error("Fixture tabs unavailable");
  });
  const { tab, front } = tabs;
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), front.id!);
  const state = () => target.evaluate(() => ({ hidden: document.hidden, focus: document.hasFocus(), submitted: (window as any).submitted, started: (window as any).started, loads: (window as any).loads }));
  const before = await state();
  assert(before.hidden, "The baseline must be a genuinely hidden page, not a Playwright-focus-emulated fixture");
  const legacy = await worker.evaluate(async id => (globalThis as any).runBackground(id, true), tab.id!);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.code, "GEMINI_RESPONSE_TIMEOUT");
  assert.equal((await state()).submitted, 1);
  assert.equal((await state()).started, 0);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), tab.id!);
  assert.equal((await state()).started, 1, "Manual activation must unblock the old background request");
  await target.goto("https://gemini.google.com/app");
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), front.id!);
  const started = Date.now();
  const fixed = await worker.evaluate(async id => (globalThis as any).runBackground(id, false), tab.id!);
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(fixed.text, "SMOKE_OK");
  const after = await state();
  assert.equal(after.submitted, 1); assert.equal(after.started, 1);
  assert(after.hidden, "Debugger detach must restore normal hidden-page visibility");
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ active: true })))[0].id, front.id);
  assert.equal(await foreground.locator("textarea").inputValue(), "Untouched draft");
  const fixedMs = Date.now() - started;
  const second = await worker.evaluate(async id => (globalThis as any).runBackground(id, false), tab.id!);
  assert.equal(second.ok, true, JSON.stringify(second));
  const afterNewChat = await state();
  assert.equal(afterNewChat.loads, after.loads + 1, "Gemini new_chat navigation should run once, never reload while reading its response");
  assert.equal(afterNewChat.submitted, 1); assert.equal(afterNewChat.started, 1);
  assert.equal(afterNewChat.hidden, true);
  assert.equal((await worker.evaluate(() => chrome.tabs.query({ active: true })))[0].id, front.id);
  assert.equal(await foreground.locator("textarea").inputValue(), "Untouched draft");
  const report = { status: "passed", baseline: before, legacy, manualActivationStarted: true, fixed, fixedMs, after, second, afterNewChat, foregroundUntouched: true, realProviderRequests: 0 };
  await mkdir(resolve(".tmp"), { recursive: true });
  await writeFile(resolve(".tmp/crx-background-regression.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (child.exitCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(basename(temporary).startsWith("webchat-ai-background-crx-"));
  await rm(temporary, { recursive: true, force: true });
}
