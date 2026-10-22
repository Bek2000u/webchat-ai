import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { DesktopUpdateStatus } from "../../desktop/updates.js";
import { t } from "../i18n.js";
import { Button } from "./ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";

function useDesktopUpdates(onStatus?: (status: DesktopUpdateStatus) => void) {
  const [status, setStatus] = useState<DesktopUpdateStatus>();
  const listener = useRef(onStatus);
  listener.current = onStatus;
  useEffect(() => {
    const desktop = window.webchatAI;
    if (!desktop) return;
    let active = true;
    const receive = (value: DesktopUpdateStatus) => {
      if (active) { setStatus(value); listener.current?.(value); }
    };
    const unsubscribe = desktop.onUpdateStatus(receive);
    void desktop.getUpdateStatus().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return status;
}
function updateLabel(status: DesktopUpdateStatus) {
  switch (status.state) {
    case "disabled": return t("Обновления доступны в установленном приложении.");
    case "checking": return t("Проверка обновлений…");
    case "available": return t("Доступна версия {{version}}", { version: status.version });
    case "downloading": return t("Загрузка обновления: {{percent}}%", { percent: Math.round(status.percent ?? 0) });
    case "downloaded": return t("Версия {{version}} готова к установке", { version: status.version });
    case "error": return t("Не удалось обновить приложение. Повторите попытку.");
    default: return t(status.checkedAt ? "Установлена последняя версия" : "Обновления через GitHub Releases");
  }
}
function UpdateControls({ status }: { status: DesktopUpdateStatus }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setPending(true); setFailed(false);
    try { await action(); } catch { setFailed(true); } finally { setPending(false); }
  }
  return <div className="space-y-3">
    <p role="status" aria-live="polite">{updateLabel(status)}</p>
    {status.state === "downloading" && <progress className="w-full" max={100} value={status.percent ?? 0} aria-label={t("Загрузка обновления")} />}
    <div className="flex flex-wrap gap-2">
      {!["disabled", "downloading", "downloaded"].includes(status.state) && <Button variant="outline" disabled={pending || status.state === "checking"} onClick={() => void run(() => window.webchatAI!.checkForUpdates())}><RefreshCw className="size-4" />{t("Проверить обновления")}</Button>}
      {status.state === "available" && <Button disabled={pending} onClick={() => void run(() => window.webchatAI!.downloadUpdate())}><Download className="size-4" />{t("Скачать обновление")}</Button>}
      {status.state === "downloaded" && <Button disabled={pending} onClick={() => void run(() => window.webchatAI!.installUpdate())}>{t("Установить и перезапустить")}</Button>}
    </div>
    {failed && <p className="text-destructive" role="alert">{t("Не удалось обновить приложение. Повторите попытку.")}</p>}
  </div>;
}
export function DesktopUpdateCard() {
  const status = useDesktopUpdates();
  if (!window.webchatAI || !status) return null;
  return <Card><CardHeader><CardTitle>{t("Обновления Desktop")}</CardTitle><CardDescription>{t("Версия {{version}}", { version: status.currentVersion })}</CardDescription></CardHeader><CardContent className="space-y-3 text-sm"><UpdateControls status={status} /><p className="text-muted-foreground">{t("Расширение обновляется вместе с Desktop. Его popup предложит перезагрузку после завершения генераций.")}</p></CardContent></Card>;
}
export function DesktopUpdateNotification() {
  const [open, setOpen] = useState(false);
  const seen = useRef("");
  const status = useDesktopUpdates(value => {
    if (["available", "downloaded"].includes(value.state) && value.version && seen.current !== value.version + value.state) {
      seen.current = value.version + value.state; setOpen(true);
    }
  });
  if (!window.webchatAI || !status) return null;
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>{t("Обновление WebChat AI")}</DialogTitle><DialogDescription>{t("Скачайте обновление, затем выберите удобный момент для перезапуска.")}</DialogDescription></DialogHeader><UpdateControls status={status} /></DialogContent></Dialog>;
}
