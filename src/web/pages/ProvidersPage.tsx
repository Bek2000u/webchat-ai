import { t, localeTag } from "../i18n.js";
import { Fragment, useState } from "react";
import { Blocks, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { MODELS, PROVIDERS } from "../../shared/contracts.js";
import { useProviderProfiles } from "../hooks/useProviderProfiles.js";
import { matchesSlot, pendingCounts, providerLabel, providerSlots, workerAvailable } from "../lib/provider-tables.js";
import { ErrorDetail, ProviderProfilesTable } from "../components/providers/ProviderProfilesTable.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

const kindLabels: Record<string, string> = { text: "Текст", image: "Изображения", video: "Видео", audio: "Речь" };
export function ProvidersPage() {
  const { profiles, jobs, stats, usingDemo, busy, toggle, reloadStatus } = useProviderProfiles();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const slots = providerSlots(profiles), queue = stats?.queue ?? pendingCounts(jobs);
  const providerIds = [...new Set([...Object.keys(PROVIDERS), ...slots.map(slot => slot.worker.provider_id)])];
  const visible = providerIds.filter(id => !query.trim() || providerLabel(id).toLowerCase().includes(query.trim().toLowerCase()) || slots.some(slot => slot.worker.provider_id === id && matchesSlot(slot, query)));
  function expand(id: string) { setExpanded(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><Blocks className="size-4" aria-hidden="true" />{providerIds.length} {t("сервисов")} {usingDemo && <Badge variant="outline">{t("Демо")}</Badge>}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Доступные Chrome-профили, нагрузка и последние результаты")}</p></div>
      <Button variant="outline" size="icon" onClick={() => void reloadStatus()} aria-label={t("Обновить данные")}><RefreshCw className="size-4" aria-hidden="true" /></Button></div>
    <div className="flex flex-wrap items-center gap-3"><Input aria-label={t("Поиск провайдера или аккаунта сайта")} placeholder={t("Найти провайдера или email…")} value={query} onChange={event => setQuery(event.target.value)} className="max-w-sm" /><span className="text-xs text-muted-foreground">{t("В очереди auto:")} <strong className="text-foreground tabular-nums">{queue.auto}</strong></span></div>
    <div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead><span className="sr-only">{t("Раскрыть")}</span></TableHead><TableHead>{t("Провайдер")}</TableHead><TableHead>{t("Возможности")}</TableHead><TableHead>{t("Доступны / всего")}</TableHead><TableHead>{t("В работе")}</TableHead><TableHead>{t("В очереди")}</TableHead><TableHead>{t("Последняя ошибка")}</TableHead></TableRow></TableHeader><TableBody>
      {visible.map(id => {
        const rows = slots.filter(slot => slot.worker.provider_id === id), open = expanded.has(id);
        const lastError = rows.flatMap(slot => slot.worker.health?.lastError ? [slot.worker.health.lastError] : []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
        const connectionError = rows.find(slot => slot.worker.enabled && slot.worker.online && slot.worker.connection_error)?.worker.connection_error;
        const kinds = [...new Set(MODELS.filter(model => model.providerId === id).map(model => t(kindLabels[model.kind])))];
        return <Fragment key={id}><TableRow className="text-sm">
          <TableCell className="w-10"><Button variant="ghost" size="icon-sm" onClick={() => expand(id)} aria-expanded={open} aria-controls={`provider-${id}`} aria-label={t("{{v0}} профили {{v1}}", {v0: open ? t("Скрыть") : t("Показать"), v1: providerLabel(id)})}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</Button></TableCell>
          <TableCell className="font-medium"><button onClick={() => expand(id)} aria-expanded={open} className="cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">{providerLabel(id)}</button></TableCell>
          <TableCell className="text-xs text-muted-foreground">{kinds.join(" · ") || "—"}</TableCell>
          <TableCell className="tabular-nums">{rows.filter(slot => workerAvailable(slot.worker)).length}/{rows.length}</TableCell>
          <TableCell className="tabular-nums">{rows.reduce((sum, slot) => sum + slot.worker.active_jobs, 0)}</TableCell>
          <TableCell className="tabular-nums">{queue.providers[id] || 0}</TableCell>
          <TableCell>{connectionError ? <ErrorDetail error={connectionError} /> : lastError ? <ErrorDetail error={lastError.error} at={lastError.at} observed /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
        </TableRow>{open && <TableRow id={`provider-${id}`} className="bg-muted/20 hover:bg-muted/20"><TableCell colSpan={7} className="px-3 py-2"><ProviderProfilesTable slots={rows} busy={busy} onToggle={toggle} /></TableCell></TableRow>}</Fragment>;
      })}{visible.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{t("Ничего не найдено")}</TableCell></TableRow>}
    </TableBody></Table></div>
  </div>;
}
