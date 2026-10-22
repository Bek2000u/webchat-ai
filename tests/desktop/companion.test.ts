import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncDesktopCompanion } from "../../src/desktop/companion.js";

async function fixture() {
  const root = resolve("tmp/desktop-updates");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "companion-"));
  const source = join(directory, "bundle"), data = join(directory, "user-data");
  await mkdir(source);
  await mkdir(data);
  await writeFile(join(source, "manifest.json"), JSON.stringify({ version: "1.0.1", key: "stable-manifest-key" }));
  await writeFile(join(source, "background.js"), "bundle-v1");
  return { source, data };
}

test("companion assets use a stable writable path and retain the previous bundle", async () => {
  const { source, data } = await fixture();
  await writeFile(join(data, "app.sqlite3"), "existing-db");
  const first = await syncDesktopCompanion(source, data);
  assert.deepEqual(first, { extensionDir: join(data, "extension"), extensionVersion: "1.0.1", extensionDirectoryUpdated: true });
  assert.equal((await syncDesktopCompanion(source, data)).extensionDirectoryUpdated, false);
  await writeFile(join(source, "background.js"), "bundle-v2");
  const updated = await syncDesktopCompanion(source, data);
  assert.equal(updated.extensionDir, first.extensionDir);
  assert.equal(updated.extensionDirectoryUpdated, true);
  assert.equal(await readFile(join(updated.extensionDir, "background.js"), "utf8"), "bundle-v2");
  assert.equal(await readFile(join(data, "extension.previous/background.js"), "utf8"), "bundle-v1");
  assert.equal(await readFile(join(data, "app.sqlite3"), "utf8"), "existing-db");
});

test("a changed companion identity cannot replace the installed extension", async () => {
  const { source, data } = await fixture();
  await syncDesktopCompanion(source, data);
  await writeFile(join(source, "manifest.json"), JSON.stringify({ version: "1.0.2", key: "different-key" }));
  await assert.rejects(syncDesktopCompanion(source, data), /identity changed/);
  assert.equal(JSON.parse(await readFile(join(data, "extension/manifest.json"), "utf8")).key, "stable-manifest-key");
  assert.equal(await readFile(join(data, "extension/background.js"), "utf8"), "bundle-v1");
});
