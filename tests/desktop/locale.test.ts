import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { desktopMessages, isDesktopLanguage, readDesktopLanguage, saveDesktopLanguage } from "../../src/desktop/locale.js";

test("native language defaults to the system locale and persists the user's choice", async () => {
  const root = resolve("tmp/desktop-updates");
  await mkdir(root, { recursive: true });
  const data = await mkdtemp(join(root, "locale-"));
  assert.equal(readDesktopLanguage(data, "uz-UZ"), "uz");
  assert.equal(readDesktopLanguage(data, "en-US"), "ru");
  saveDesktopLanguage(data, "uz");
  assert.equal(readDesktopLanguage(data, "ru-RU"), "uz");
  assert.notEqual(desktopMessages("uz").updates, desktopMessages("ru").updates);
  await writeFile(join(data, "desktop-preferences.json"), "invalid json");
  assert.equal(readDesktopLanguage(data, "ru"), "ru");
  assert.equal(isDesktopLanguage("uz"), true);
  assert.equal(isDesktopLanguage("en"), false);
});
