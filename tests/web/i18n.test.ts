import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import ru from "../../src/web/locales/ru.json";
import uz from "../../src/web/locales/uz.json";
import { i18n, localeTag, t } from "../../src/web/i18n.js";
import { Sidebar } from "../../src/web/components/layout/Sidebar.js";

test("RU and UZ cover the same UI and updater messages with intact placeholders", () => {
  assert.deepEqual(Object.keys(uz).sort(), Object.keys(ru).sort());
  for (const [key, value] of Object.entries(ru)) {
    const translated = uz[key as keyof typeof uz];
    assert.ok(translated.trim(), key);
    assert.deepEqual(translated.match(/{{\w+}}/g)?.sort() ?? [], value.match(/{{\w+}}/g)?.sort() ?? [], key);
    assert.doesNotMatch(translated, /[А-Яа-яЁё]/, key);
  }
});
test("switching language updates navigation, date locale and interpolated updater labels", async () => {
  const navigation = () => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(Sidebar, {
    collapsed: false, open: true, onClose() {}, onCollapse() {},
  })));
  try {
    await i18n.changeLanguage("ru");
    assert.match(navigation(), /Настройки/);
    await i18n.changeLanguage("uz");
    assert.match(navigation(), /Sozlamalar/);
    assert.doesNotMatch(navigation(), /Настройки/);
    assert.equal(localeTag(), "uz-UZ");
    assert.match(t("Доступна версия {{version}}", { version: "0.3.0" }), /0\.3\.0/);
    assert.equal(t("Мягкий"), uz["Мягкий"]);
  } finally { await i18n.changeLanguage("ru"); }
});
