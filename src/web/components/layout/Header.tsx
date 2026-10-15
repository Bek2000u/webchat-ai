import { Menu, Moon, Sun, RefreshCw } from "lucide-react";
import { useTheme } from "../../ThemeProvider.js";
import { cn } from "../../lib/utils.js";

type Props = { loading: boolean; failed: boolean; onMenu(): void; onReload(): void };
export function Header({loading, failed, onMenu, onReload}: Props) {
  const {theme, toggleTheme} = useTheme();
  return <header className="border-b bg-background relative z-30 flex h-14 shrink-0 items-center justify-between gap-3 px-4">
    <div className="flex min-w-0 items-center gap-3">
      <button className="md:hidden rounded-lg p-2" onClick={onMenu} aria-label="Открыть меню"><Menu className="size-5" /></button>
      <img src="/webchat-ai.png" alt="" className="size-8 object-contain" />
      <span className="text-lg font-bold tracking-tight">WebChat AI</span>
    </div>
    <div className="flex items-center gap-2 sm:gap-4">
      <button className="rounded-lg p-2 hover:bg-muted" onClick={toggleTheme} aria-label={theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему"}>
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
      <button className="rounded-lg p-2 hover:bg-muted" onClick={onReload} disabled={loading} aria-label="Обновить данные"><RefreshCw className={cn("size-4", loading && "animate-spin")} /></button>
      <div className="flex items-center gap-2 rounded-full border border-border bg-muted/50 px-3 py-1.5 text-xs" role="status">
        <span className={cn("size-2 rounded-full", failed ? "bg-destructive" : "bg-emerald-500")} aria-hidden="true" />
        <span className="hidden sm:inline font-mono">{window.location.host}</span>
        <span>{failed ? "API недоступен" : "Local API"}</span>
      </div>
    </div>
  </header>;
}
