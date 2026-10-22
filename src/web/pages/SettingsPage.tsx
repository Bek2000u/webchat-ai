import { t, localeTag } from "../i18n.js";
import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, FolderOpen, LoaderCircle, Puzzle, Route, Server, ShieldCheck } from "lucide-react";
import { useAppDataContext } from "../AppContext.js";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "../components/ui/card.js";
import { Button } from "../components/ui/button.js";
import { toast } from "sonner";
import { saveServerConfig } from "../api/app.js";
import { modelSpec } from "../../shared/contracts.js";
import { VideoForgeConnectorSettings } from "../components/VideoForgeConnectorSettings.js";
import { DesktopUpdateCard } from "../components/DesktopUpdates.js";

export function SettingsPage() {
  const { systemInfo, serverConfig, reloadApiKeys } = useAppDataContext();
  const [desktop, setDesktop] = useState<Awaited<ReturnType<NonNullable<Window["webchatAI"]>["getInfo"]>>>();
  const [order, setOrder] = useState<string[] | null>(null);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => { void window.webchatAI?.getInfo().then(setDesktop).catch(() => toast.error(t("Не удалось прочитать настройки Desktop"))); }, []);
  useEffect(() => {
    if (!serverConfig) return;
    setOrder([...serverConfig.textProviderOrder]);
    setSavedOrder([...serverConfig.textProviderOrder]);
  }, [serverConfig]);
  function move(id: string, direction: -1 | 1) {
    setOrder((current) => {
      if (!current) return current;
      const index = current.indexOf(id), target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSaveError("");
  }
  async function saveOrder() {
    if (!order || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const config = await saveServerConfig(order);
      setOrder(config.textProviderOrder);
      setSavedOrder(config.textProviderOrder);
      toast.success(t("Порядок провайдеров сохранён"));
      await reloadApiKeys();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t("Не удалось сохранить порядок провайдеров"));
    } finally { setSaving(false); }
  }
  async function open(action: (() => Promise<string>) | undefined) {
    try { const error = await action?.(); if (error) toast.error(t("Не удалось открыть папку")); }
    catch { toast.error(t("Не удалось открыть папку")); }
  }
  return <div className="grid gap-4 xl:grid-cols-2">
    <DesktopUpdateCard />
    <VideoForgeConnectorSettings />
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Route className="size-4" aria-hidden="true" />{t("Маршрутизация")}</CardTitle><CardDescription>{t("Порядок текстовых провайдеров для модели auto")}</CardDescription></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {order ? <ol className="divide-y rounded-lg border" aria-label={t("Приоритет провайдеров")}>{order.map((id, index) => {
          const label = modelSpec(id)?.label ?? id;
          return <li key={id} className="flex min-w-0 items-center gap-3 px-3 py-1">
            <span className="w-4 shrink-0 text-center tabular-nums text-muted-foreground" aria-hidden="true">{index + 1}</span>
            <span className="min-w-0 flex-1">{t(label)}</span>
            <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={t("Поднять {{v0}}", {v0: label})} disabled={saving || index === 0} onClick={() => move(id, -1)}><ArrowUp className="size-4" aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={t("Опустить {{v0}}", {v0: label})} disabled={saving || index === order.length - 1} onClick={() => move(id, 1)}><ArrowDown className="size-4" aria-hidden="true" /></Button>
          </li>;
        })}</ol> : <p className="text-muted-foreground" role="status">{t("Загрузка настроек…")}</p>}
        <p className="text-muted-foreground">{t("Выбирается свободный профиль с учётом health и последнего назначения. Явно указанная модель не меняет провайдера; выполняющиеся запросы не прерываются.")}</p>
        <p className="text-muted-foreground">{t("Временная ошибка: один повтор. Невалидный текст: до трёх попыток. Постоянных блокировок по health нет.")}</p>
        {saveError && <p className="text-destructive" role="alert">{saveError}</p>}
        <Button type="button" disabled={!order || saving || JSON.stringify(order) === JSON.stringify(savedOrder)} onClick={() => void saveOrder()}>{saving && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? t("Сохранение…") : t("Сохранить")}</Button>
      </CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4" />{t("API")}</CardTitle><CardDescription>{t("Тот же host для Desktop и клиентских приложений")}</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm"><p className="break-all rounded-lg bg-muted p-3 font-mono">{desktop?.origin || window.location.origin}</p><p className="text-muted-foreground">{t("Клиенты используют API-ключи. Сессии сайтов остаются в Chrome, не в Desktop.")}</p><p>{t("Версия")} {desktop?.version || systemInfo?.version || "—"}</p></CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Puzzle className="size-4" />WebChat Extension</CardTitle><CardDescription>{t("Расширение для Chrome")}</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm"><p className="text-muted-foreground">{t("Для Desktop установите WebChat Extension; подключение автоматическое. Для Docker установите WebChat Server Extension и укажите адрес сервера и токен.")}</p>{desktop && <><p className="break-all font-mono text-xs">{desktop.extensionDir}</p><Button variant="outline" onClick={() => void open(window.webchatAI?.openExtensionDirectory)}><Puzzle className="size-4" />{t("Папка расширения")}</Button></>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><FolderOpen className="size-4" />{t("Данные")}</CardTitle><CardDescription>{t("SQLite, результаты и настройки на устройстве API")}</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">{desktop ? <><p className="break-all font-mono text-xs">{desktop.dataDir}</p><Button variant="outline" onClick={() => void open(window.webchatAI?.openDataDirectory)}><FolderOpen className="size-4" />{t("Открыть папку")}</Button></> : <p className="text-muted-foreground">{t("Папка задаётся в конфигурации запущенного host.")}</p>}</CardContent></Card>
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />WebChat AI</CardTitle><CardDescription>Desktop-first · Chrome extension · API/SDK</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground"><p>{t("WebChat AI — приложение под лицензией MIT.")}</p>{desktop && <p>{t("Генерации выполняются в вашем Chrome. Закрытие окна оставляет API в трее; команда «Выйти» останавливает приложение.")}</p>}</CardContent></Card>
  </div>;
}
