import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import ru from "./locales/ru.json";
import uz from "./locales/uz.json";

export type Language = "ru" | "uz";
const storageKey = "webchat-ai-language";
function initialLanguage(): Language {
  try {
    const saved = globalThis.localStorage?.getItem(storageKey);
    if (saved === "ru" || saved === "uz") return saved;
  } catch { /* Storage can be disabled by the browser. */ }
  return globalThis.navigator?.language?.startsWith("uz") ? "uz" : "ru";
}
export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: initialLanguage(), fallbackLng: "ru", supportedLngs: ["ru", "uz"],
  resources: { ru: { translation: ru }, uz: { translation: uz } },
  keySeparator: false, nsSeparator: false, initAsync: false,
  interpolation: { escapeValue: false }, react: { useSuspense: false },
});
export function t(key: string, values?: Record<string, unknown>): string {
  return i18n.t(key, values ?? {}) as string;
}
export function localeTag() { return i18n.language === "uz" ? "uz-UZ" : "ru-RU"; }
export async function setLanguage(language: Language) {
  await i18n.changeLanguage(language);
  try { globalThis.localStorage?.setItem(storageKey, language); } catch { /* Keep the current session usable. */ }
  if (typeof window !== "undefined") await window.webchatAI?.setLanguage(language);
}
function updateDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.language;
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();
