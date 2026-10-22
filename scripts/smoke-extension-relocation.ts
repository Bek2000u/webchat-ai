import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";

/** Owned, isolated Chrome fixture. Never loads user profiles or calls vendors. */
const temporary = await mkdtemp(join(tmpdir(), "webchat-ai-relocation-"));
const context = await chromium.launchPersistentContext(join(temporary, "profile"), {
  channel: "chromium",
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions"],
  args: ["--enable-unsafe-extension-debugging", "--disable-background-networking"],
  proxy: { server: "http://127.0.0.1:9" },
});
try {
  const session = await context.browser()!.newBrowserCDPSession();
  const results = [];
  for (const [build, expectedId] of [
    ["dist/extension/chrome-mv3", "pnamggpmjbeoohafaokfcjhpdmijmmda"],
    ["dist/extension-dev/chrome-mv3-dev", "epmfnjjinilkfldoafibcgkpenbhlidm"],
  ]) {
    const source = join(temporary, "before-" + expectedId), target = join(temporary, "after-" + expectedId);
    const built = JSON.parse(await readFile(resolve(build, "manifest.json"), "utf8"));
    const manifest = { manifest_version: 3, name: "Chat2API relocation fixture", version: "1.0.0", key: built.key, permissions: ["storage"] };
    await mkdir(source);
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(source, "fixture.html"), "<!doctype html><title>Relocation fixture</title>");
    const before = await session.send("Extensions.loadUnpacked", { path: source });
    assert.equal(before.id, expectedId);
    const values = {
      "browser.profileId": "fixture-existing-profile",
      "browser.host.settings": JSON.stringify({ token: "fixture-credential", origin: "http://127.0.0.1:8001" }),
      "provider.enabled:google_vids": "false",
      "provider.tab:google_vids": "123",
    };
    const page = await context.newPage();
    await page.goto(`chrome-extension://${before.id}/fixture.html`);
    await page.evaluate(values => chrome.storage.local.set(values), values);
    await rename(source, target);
    await writeFile(join(target, "manifest.json"), JSON.stringify({ ...manifest, name: built.name }));
    // Same action as Load unpacked with the new path. No uninstall/clearStorage.
    const after = await session.send("Extensions.loadUnpacked", { path: target });
    assert.equal(after.id, before.id);
    const updatedPage = await context.newPage();
    await updatedPage.goto(`chrome-extension://${after.id}/fixture.html`);
    assert.deepEqual(await updatedPage.evaluate(() => chrome.storage.local.get(null)), values);
    const matches = (await session.send("Extensions.getExtensions")).extensions.filter(item => item.id === after.id);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, built.name);
    assert.equal(resolve(matches[0].path), target);
    await updatedPage.close();
    if (!page.isClosed()) await page.close();
    results.push({ id: after.id, name: matches[0].name, pathUpdated: true, storagePreserved: true });
  }
  const report = { status: "passed", results, userProfilesTouched: 0, realProviderRequests: 0 };
  await mkdir(resolve(".tmp"), { recursive: true });
  await writeFile(resolve(".tmp/extension-relocation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await context.close();
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(basename(temporary).startsWith("webchat-ai-relocation-"));
  await rm(temporary, { recursive: true, force: true });
}
