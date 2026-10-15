import assert from "node:assert/strict";
import test from "node:test";
import { prepareGoogleVidsUi, readGoogleVidsVoicePanel } from "../../src/extension/providers/google-vids/ui.js";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";

test("Vids recognizes the native panel when scene labels are nested spans, not buttons", () => {
  const { window } = parseHTML('<html><body><div id="panel"><div><span>Эта сцена</span><span>Все сцены</span></div></div></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", { value: () => [{}] });
  const read = () => runInNewContext(`(${readGoogleVidsVoicePanel.toString()})()`, { document: window.document, __name: (value: unknown) => value });
  assert.equal(read(), true);
  window.document.querySelector("#panel")!.setAttribute("hidden", "");
  assert.equal(read(), false);
});

test("Vids trusts captured native readiness without requiring scene tabs or toggling the sidebar again", async () => {
  let ready = false, clicks = 0;
  const page = {
    locator: () => ({ isVisible: async () => false, click: async () => { clicks++; ready = true; } }),
    evaluate: async () => false,
    waitFor: async (check: () => Promise<unknown>) => assert.ok(await check()),
  };
  await prepareGoogleVidsUi(page as never, async () => ready);
  await prepareGoogleVidsUi(page as never, async () => ready);
  assert.equal(clicks, 1);
});

for (const welcome of [true, false]) test(`Vids prepares voiceover without Generate (welcome=${welcome})`, async () => {
  let dialog = welcome, voice = false;
  const actions: string[] = [];
  const page = {
    locator(selector: string) {
      return {
        isVisible: async () => dialog,
        click: async () => {
          assert.ok(!/Generate|Сгенерировать/.test(selector));
          if (selector.includes('[aria-label="Close"]')) { actions.push("close"); dialog = false; }
          else { assert.ok(!dialog); actions.push("voiceover"); voice = true; }
        },
      };
    },
    evaluate: async () => voice,
    waitFor: async (check: () => Promise<unknown>) => assert.ok(await check()),
  };
  await prepareGoogleVidsUi(page as never);
  assert.deepEqual(actions, welcome ? ["close", "voiceover"] : ["voiceover"]);
  await prepareGoogleVidsUi(page as never);
  assert.equal(actions.filter(x => x === "voiceover").length, 1);
});
