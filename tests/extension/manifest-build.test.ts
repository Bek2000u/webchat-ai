import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
// Build validation is an application build script, not runtime SDK code.
// @ts-expect-error JavaScript build helper has no runtime TypeScript declaration.
import { checkBuild } from "../../scripts/extension/check-build.mjs";

test("WebChat AI keeps both existing Chrome extension IDs and profile storage keys", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../src/extension/manifest.json", import.meta.url), "utf8"));
  const config = await readFile(new URL("../../src/extension/wxt.config.ts", import.meta.url), "utf8");
  const id = (key: string) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)]
    .map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join("");
  assert.equal(manifest.name, "WebChat AI Companion");
  assert.equal(id(manifest.key), "pnamggpmjbeoohafaokfcjhpdmijmmda");
  assert.equal(id(/key:\s*"([A-Za-z0-9+/=]+)"/.exec(config)![1]), "epmfnjjinilkfldoafibcgkpenbhlidm");
  assert.match(config, /name: "WebChat AI Companion Dev"/);
  const runtime = await readFile(new URL("../../src/extension/runtime/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /"browser\.profileId"/);
  assert.match(runtime, /"browser\.host\.settings"/);
});

test("manifest never registers the removed DeepSeek hook; media hooks remain", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../src/extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.content_scripts.flatMap((entry: { js: string[] }) => entry.js), ["flow-native-captcha.js", "google-vids-capture.js"]);
});

test("packaged manifest validation rejects missing content scripts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "companion-manifest-test-"));
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ content_scripts: [{ js: ["removed.js"] }] }));
    await assert.rejects(checkBuild(dir), /Manifest references missing file: removed.js/);
    await writeFile(join(dir, "removed.js"), "// fixture");
    assert.equal(await checkBuild(dir), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("packaged manifest validation also checks the worker, options and icons", async () => {
  for (const manifest of [{ background: { service_worker: "worker.js" } }, { options_ui: { page: "options.html" } }, { icons: { 16: "icon.png" } }]) {
    const dir = await mkdtemp(join(tmpdir(), "companion-manifest-test-"));
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
      await assert.rejects(checkBuild(dir), /Manifest references missing file/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
