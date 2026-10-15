import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSender } from "../../src/extension/background.js";

test("extension settings work as a full Chrome tab and popup, but provider/content messages stay untrusted", () => {
  const id = "a".repeat(32),
    url = `chrome-extension://${id}/options.html`;
  assert.equal(isSettingsSender({ id, url }, id, url), true);
  assert.equal(
    isSettingsSender({ id, url, tab: { id: 1 } as chrome.tabs.Tab }, id, url),
    true,
  );
  assert.equal(
    isSettingsSender({ id, url: url + "?view=connection#settings" }, id, url),
    true,
  );
  for (const sender of [
    { id, url: "https://chatgpt.com/" },
    { id: "b".repeat(32), url },
    { id, url: url + "/evil" },
    { id, url: url.replace("options.html", "provider-context.js") },
    { id },
  ])
    assert.equal(isSettingsSender(sender, id, url), false);
});
