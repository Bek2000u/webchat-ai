import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DesktopLanguage = "ru" | "uz";
export function isDesktopLanguage(value: unknown): value is DesktopLanguage { return value === "ru" || value === "uz"; }

export function readDesktopLanguage(dataDirectory: string, systemLocale: string): DesktopLanguage {
  try {
    const value = JSON.parse(readFileSync(join(dataDirectory, "desktop-preferences.json"), "utf8"));
    if (isDesktopLanguage(value.language)) return value.language;
  } catch { /* The app remains usable when no preference has been saved. */ }
  return systemLocale.toLowerCase().startsWith("uz") ? "uz" : "ru";
}

export function saveDesktopLanguage(dataDirectory: string, language: DesktopLanguage): void {
  writeFileSync(join(dataDirectory, "desktop-preferences.json"), JSON.stringify({ language }) + "\n", "utf8");
}

const messages = {
  ru: {
    open: "Открыть WebChat AI", extension: "Расширение Chrome", updates: "Проверить обновления", quit: "Выйти",
    tray: "WebChat AI — локальный API", stopped: "Локальный API остановился. Запросы не будут отправлены повторно.",
    startup: "Не удалось запустить локальный API. Проверьте свободный порт и доступ к данным приложения.",
  },
  uz: {
    open: "WebChat AI’ni ochish", extension: "Chrome kengaytmasi", updates: "Yangilanishlarni tekshirish", quit: "Chiqish",
    tray: "WebChat AI — mahalliy API", stopped: "Mahalliy API to‘xtadi. So‘rovlar qayta yuborilmaydi.",
    startup: "Mahalliy API ishga tushmadi. Port bo‘shligini va ilova ma’lumotlariga kirishni tekshiring.",
  },
} as const;
export function desktopMessages(language: DesktopLanguage) { return messages[language]; }
