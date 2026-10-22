import { t, localeTag } from "../i18n.js";
import { useEffect, useState } from "react";
import { Link2, LoaderCircle } from "lucide-react";
import { getVideoForgeConnector, saveVideoForgeConnector } from "../api/app.js";
import type { VideoForgeConnectorState } from "../../shared/contracts.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

export function VideoForgeConnectorSettings() {
  const [state, setState] = useState<VideoForgeConnectorState>();
  const [origin, setOrigin] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    let initialized = false;
    async function reload() {
      try {
        const value = await getVideoForgeConnector();
        if (!active) return;
        setState(value);
        if (!initialized) { initialized = true; setOrigin(value.origin); setLoaded(true); }
      } catch { if (active && !initialized) setError(t("Не удалось загрузить подключение. Обновите страницу.")); }
    }
    void reload();
    const timer = setInterval(() => void reload(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  async function save(enabled: boolean) {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const next = await saveVideoForgeConnector({ origin: enabled ? origin.trim() : state?.origin || origin.trim(), ...(enabled && token.trim() ? { token: token.trim() } : {}), enabled });
      setState(next);
      setOrigin(next.origin);
      setToken("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("Не удалось сохранить подключение")); }
    finally { setSaving(false); }
  }
  const labels = { disabled: t("Отключено"), connecting: t("Подключение…"), connected: t("Подключено"), disconnected: t("Нет соединения") };
  const savedForOrigin = state?.tokenSaved && origin.trim().replace(/\/$/, "") === state.origin;
  return <Card><CardHeader><CardTitle className="flex items-center gap-2"><Link2 className="size-4" aria-hidden="true" />VideoForge</CardTitle><CardDescription>{t("Используйте провайдеров своего Chrome в VideoForge")}</CardDescription></CardHeader>
    <CardContent className="space-y-4 text-sm">
      <p role="status" aria-live="polite">{state ? labels[state.status] : t("Загрузка подключения…")}</p>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(true); }}>
        <div className="space-y-2"><label htmlFor="videoforge-origin">{t("Адрес VideoForge")}</label><Input id="videoforge-origin" name="videoforgeOrigin" type="url" className="min-h-11" placeholder="https://videoforge.uz" value={origin} disabled={!loaded || saving} required onChange={(event) => setOrigin(event.target.value)} aria-describedby="videoforge-origin-help" /><p id="videoforge-origin-help" className="text-muted-foreground">{t("HTTPS-адрес приложения. Для разработки разрешён HTTP localhost.")}</p></div>
        <div className="space-y-2"><label htmlFor="videoforge-token">Connector token</label><Input id="videoforge-token" name="videoforgeToken" type="password" className="min-h-11" autoComplete="off" placeholder={savedForOrigin ? t("Токен сохранён; оставьте пустым") : t("Токен из настроек VideoForge")} value={token} disabled={!loaded || saving} required={!savedForOrigin} onChange={(event) => setToken(event.target.value)} aria-describedby="videoforge-token-help" /><p id="videoforge-token-help" className="text-muted-foreground">{t("Токен хранится на этом компьютере. Cookies и ключи локального API в VideoForge не передаются.")}</p></div>
        {(error || state?.error) && <p role="alert" className="text-destructive">{error || state?.error}</p>}
        <div className="flex flex-wrap gap-2"><Button type="submit" className="min-h-11" disabled={!loaded || saving}>{saving && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? t("Сохранение…") : state?.enabled ? t("Обновить подключение") : t("Подключить")}</Button><Button type="button" variant="outline" className="min-h-11" disabled={!state?.enabled || saving} onClick={() => void save(false)}>{t("Отключить")}</Button></div>
      </form>
      <p className="text-muted-foreground">{t("WebChat AI должен работать на компьютере с доступным Chrome. Соединение исходящее; открывать localhost в интернет не нужно.")}</p>
    </CardContent></Card>;
}
