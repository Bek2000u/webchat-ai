import { t, i18n, setLanguage, type Language } from "../../i18n.js";
import { Menu, Moon, Sun, RefreshCw } from "lucide-react";
import { useTheme } from "../../ThemeProvider.js";
import { cn } from "../../lib/utils.js";

type Props = { loading: boolean; failed: boolean; onMenu(): void; onReload(): void };
export function Header({loading, failed, onMenu, onReload}: Props) {
  const {theme, toggleTheme} = useTheme();
  return <header className="border-b bg-background relative z-30 flex h-14 shrink-0 items-center justify-between gap-3 px-4">
    <div className="flex min-w-0 items-center gap-3">
      <button className="md:hidden rounded-lg p-2" onClick={onMenu} aria-label={t("Открыть меню")}><Menu className="size-5" /></button>
      <img src="/webchat-ai.svg" width="32" height="32" alt="" className="size-8 shrink-0 object-contain" />
      <span className="sr-only text-lg font-bold tracking-tight sm:not-sr-only">WebChat AI</span>
    </div>
    <div className="flex items-center gap-2 sm:gap-4">
      <label className="sr-only" htmlFor="app-language">{t("Язык интерфейса")}</label>
      <select id="app-language" className="rounded-md border bg-background p-1.5 text-sm" value={i18n.language} onChange={event => void setLanguage(event.target.value as Language)}>
        <option value="ru">Русский</option><option value="uz">O‘zbekcha</option>
      </select>
      <button className="rounded-lg p-2 hover:bg-muted" onClick={toggleTheme} aria-label={theme === "dark" ? t("Включить светлую тему") : t("Включить тёмную тему")}>
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
      <button className="rounded-lg p-2 hover:bg-muted" onClick={onReload} disabled={loading} aria-label={t("Обновить данные")}><RefreshCw className={cn("size-4", loading && "animate-spin")} /></button>
      <div className="flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs" role="status">
        <span className={cn("size-2 rounded-full", failed ? "bg-destructive" : "bg-emerald-500")} aria-hidden="true" />
        <span className="hidden sm:inline font-mono">{window.location.host}</span>
        <span>{failed ? t("API недоступен") : t("API")}</span>
      </div>
    </div>
  </header>;
}
