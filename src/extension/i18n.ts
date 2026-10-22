import en from "./public/_locales/en/messages.json";
import ru from "./public/_locales/ru/messages.json";
import uz from "./public/_locales/uz/messages.json";

export const POPUP_LANGUAGE_KEY = "popup.language";
export type PopupLanguage = "en" | "ru" | "uz";
const catalogs = { en, ru, uz };
export function popupLanguage(value: unknown): PopupLanguage {
  return typeof value === "string" && value.toLowerCase().startsWith("ru") ? "ru"
    : typeof value === "string" && value.toLowerCase().startsWith("uz") ? "uz" : "en";
}
export function popupTranslator(language: PopupLanguage) {
  const catalog = catalogs[language] as Record<string, { message: string }>;
  return (key: string, substitution?: string) => {
    const message = catalog[key]?.message || (en as Record<string, { message: string }>)[key]?.message || key;
    return substitution === undefined ? message : message.replace(/\$[a-zA-Z_]+\$/g, substitution);
  };
}
