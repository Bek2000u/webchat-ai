import { t, localeTag } from "../../i18n.js";
import { Activity, CircleAlert, CircleCheck, History, Power, Wifi, WifiOff } from "lucide-react";
import { Link } from "react-router-dom";
import type { ProviderWorker, RequestError } from "../../../shared/contracts.js";
import { providerLabel, profileLabel, slotIdentity, timeLabel, workerAvailable, type ProviderSlot } from "../../lib/provider-tables.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";
import { Switch } from "../ui/switch.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.js";

export function ErrorDetail({ error, at, observed = false }: { error: RequestError; at?: string; observed?: boolean }) {
  const description = error.code === "GOOGLE_VIDS_PAID_PLAN_REQUIRED" ? t("Нужен Paid с безлимитной озвучкой")
    : /GOOGLE_VIDS_PLAN_(PENDING|UNKNOWN)/.test(error.code) ? t("Доступ Vids не подтверждён") : error.message;
  return <Dialog><DialogTrigger asChild><Button variant="ghost" size="sm" className="max-w-48 justify-start text-destructive" aria-label={`${observed ? t("Последняя ошибка") : t("Ошибка доступа")}: ${description}`}>
    <CircleAlert aria-hidden="true" className="size-3.5" /><span className="truncate">{description}</span>
  </Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{observed ? t("Последняя ошибка генерации") : t("Доступ к провайдеру")}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"><dt>{t("Код")}</dt><dd className="break-all font-mono text-xs">{error.code}</dd>
      {error.provider && <><dt>{t("Провайдер")}</dt><dd>{providerLabel(error.provider)}</dd></>}
      {error.stage && <><dt>{t("Этап")}</dt><dd>{error.stage}</dd></>}
      {at && <><dt>{t("Время")}</dt><dd>{timeLabel(at)}</dd></>}
      {observed && <><dt>{t("Наблюдение")}</dt><dd>{t("Не отключает аккаунт и не запрещает новый запрос.")}</dd></>}
    </dl></DialogContent></Dialog>;
}
export function ProviderProfilesTable({ slots, busy, onToggle }: {
  slots: ProviderSlot[]; busy: Set<string>; onToggle: (worker: ProviderWorker, enabled: boolean) => Promise<void>;
}) {
  return <TooltipProvider><Table><TableHeader><TableRow>
    <TableHead>{t("Провайдер")}</TableHead><TableHead>{t("Аккаунт сайта")}</TableHead><TableHead>{t("Chrome-профиль")}</TableHead>
    <TableHead>{t("Тариф")}</TableHead><TableHead>{t("Подключение / доступ")}</TableHead><TableHead>{t("Последний результат")}</TableHead>
    <TableHead><Activity aria-hidden="true" className="size-4" /><span className="sr-only">{t("В работе")}</span></TableHead>
    <TableHead><span className="sr-only">{t("Включён")}</span></TableHead><TableHead><span className="sr-only">{t("Запросы")}</span></TableHead>
  </TableRow></TableHeader><TableBody>{slots.map(({ profile, worker }) => {
    const error = worker.connection_error || (worker.connection_error_code ? { code: worker.connection_error_code, message: worker.connection_error_code } : undefined);
    const lastError = worker.health?.lastError, success = worker.health?.lastSuccess, tier = worker.account_status?.account_tier;
    return <TableRow key={worker.id} className="text-xs">
      <TableCell className="font-medium">{providerLabel(worker.provider_id)}</TableCell>
      <TableCell><Tooltip><TooltipTrigger asChild><span tabIndex={0} className="block max-w-52 truncate">{slotIdentity({ profile, worker })}</span></TooltipTrigger><TooltipContent>{slotIdentity({ profile, worker })}</TooltipContent></Tooltip></TableCell>
      <TableCell><span title={profile.id}>{profileLabel(profile)}</span></TableCell>
      <TableCell><span title={worker.provider_id === "google_vids" ? tier === "paid" ? t("Безлимитная озвучка") : tier === "free" ? t("Ограниченные кредиты") : t("Доступ к озвучке не подтверждён") : undefined}>{tier === "paid" ? "Paid" : tier === "free" ? "Free" : "—"}</span></TableCell>
      <TableCell><div className="flex items-center gap-1.5">{!worker.enabled ? <><Power className="size-3.5 text-muted-foreground" aria-hidden="true" />{t("Выключен")}</>
        : !worker.online ? <><WifiOff className="size-3.5 text-muted-foreground" aria-hidden="true" />{t("Не в сети")}</>
        : error ? <ErrorDetail error={error} /> : <><Wifi className={workerAvailable(worker) ? "size-3.5 text-emerald-600 dark:text-emerald-400" : "size-3.5 text-muted-foreground"} aria-hidden="true" />{worker.status === "busy" ? t("Занят") : worker.status === "ready" ? t("Готов") : t("Недоступен")}</>}</div></TableCell>
      <TableCell>{lastError ? <ErrorDetail error={lastError.error} at={lastError.at} observed /> : success ? <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CircleCheck className="size-3.5" aria-hidden="true" />{t("Успех")}</span></TooltipTrigger><TooltipContent>{timeLabel(success.at)} · {success.model}</TooltipContent></Tooltip> : <span className="text-muted-foreground">{t("Нет наблюдений")}</span>}</TableCell>
      <TableCell className="tabular-nums">{worker.active_jobs}</TableCell>
      <TableCell><Switch size="sm" checked={worker.enabled} disabled={busy.has(worker.id)} onCheckedChange={enabled => void onToggle(worker, enabled)} aria-label={t("{{v0}} {{v1}} в {{v2}}", {v0: worker.enabled ? "Выключить" : "Включить", v1: providerLabel(worker.provider_id), v2: profileLabel(profile)})} /></TableCell>
      <TableCell><Button asChild variant="ghost" size="icon-sm"><Link to={`/requests?provider=${encodeURIComponent(worker.provider_id)}&account=${encodeURIComponent(profile.id)}`} aria-label={t("Запросы {{v0}} в {{v1}}", {v0: providerLabel(worker.provider_id), v1: profileLabel(profile)})}><History className="size-3.5" aria-hidden="true" /></Link></Button></TableCell>
    </TableRow>;
  })}{slots.length === 0 && <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">{t("Нет подключённых аккаунтов")}</TableCell></TableRow>}</TableBody></Table></TooltipProvider>;
}
