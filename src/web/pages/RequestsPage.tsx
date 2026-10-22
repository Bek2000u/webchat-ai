import { t, localeTag } from "../i18n.js";
import { Activity, Eye, Inbox, Loader2, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getJobDetail } from "../api/app.js";
import { useAppDataContext } from "../AppContext.js";
import { FilterBar } from "../components/filters/FilterBar.js";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";
import { isPeriodFilter, matchesPeriod, uniqueValues, type PeriodFilter } from "../lib/table-filters.js";
import { cn } from "../lib/utils.js";
import { type JobDetail, type JobStatus } from "../../shared/contracts.js";

const statusLabels: Record<JobStatus, string> = {
  queued: "В очереди",
  claimed: "В работе",
  succeeded: "Готово",
  failed: "Ошибка"
};

type JobStatusFilter = JobStatus | "all" | "active";
type SpeedFilter = "all" | "slow";

const statusFilterLabels: Record<JobStatusFilter, string> = {
  all: "Все статусы",
  active: "Активные",
  ...statusLabels
};

const periodLabels: Record<PeriodFilter, string> = {
  all: "За всё время",
  hour: "Последний час",
  today: "Сегодня",
  "7d": "Последние 7 дней"
};

function isStatusFilter(value: string | null): value is JobStatusFilter {
  return value === "all" || value === "active" || value === "queued" || value === "claimed" || value === "succeeded" || value === "failed";
}

function isSpeedFilter(value: string | null): value is SpeedFilter {
  return value === "all" || value === "slow";
}

function formatTimestamp(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(localeTag());
}

function formatDuration(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return t("{{v0}} мс", {v0: Math.round(value)});
  return t("{{v0}} с", {v0: (value / 1000).toFixed(1)});
}

function statusBadge(status: JobStatus) {
  return (
    <Badge
      variant={status === "failed" ? "destructive" : status === "succeeded" ? "default" : "secondary"}
    >
      {t(statusLabels[status])}
    </Badge>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>
      <pre className="max-h-56 overflow-auto rounded-md border bg-muted p-3 text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export function RequestsPage() {
  const { jobs, accounts, reloadStatus } = useAppDataContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const detailId = searchParams.get("job");
  const detailRevision = jobs.find((job) => job.id === detailId)?.updated_at;
  const query = searchParams.get("q") || "";
  const status = isStatusFilter(searchParams.get("status")) ? searchParams.get("status") as JobStatusFilter : "all";
  const speed = isSpeedFilter(searchParams.get("speed")) ? searchParams.get("speed") as SpeedFilter : "all";
  const provider = searchParams.get("provider") || "all";
  const account = searchParams.get("account") || "all";
  const kind = searchParams.get("kind") || "all";
  const model = searchParams.get("model") || "all";
  const worker = searchParams.get("worker") || "all";
  const period = isPeriodFilter(searchParams.get("period")) ? searchParams.get("period") as PeriodFilter : "all";
  const providers = useMemo(() => uniqueValues(jobs.map((job) => job.provider_id)), [jobs]);
  const accountByWorker = useMemo(() => {
    const result = new Map<string, { id: string; email: string }>();
    accounts.forEach((item) => item.providers.forEach((worker) => {
      result.set(worker.id, { id: item.id, email: worker.account_subject || t(item.label) });
    }));
    return result;
  }, [accounts]);
  const kinds = useMemo(() => uniqueValues(jobs.map((job) => job.kind)), [jobs]);
  const models = useMemo(() => uniqueValues(jobs.map((job) => job.model)), [jobs]);
  const workers = useMemo(() => uniqueValues(jobs.map((job) => job.worker_id)), [jobs]);
  const filtersActive = Boolean(query.trim()) || status !== "all" || speed !== "all" || provider !== "all" || account !== "all" || kind !== "all" || model !== "all" || worker !== "all" || period !== "all";

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (status === "active" && job.status !== "queued" && job.status !== "claimed") return false;
      if (status !== "all" && status !== "active" && job.status !== status) return false;

      if (speed === "slow" && (!Number.isFinite(job.duration_ms) || Number(job.duration_ms) < 10_000)) return false;
      if (provider !== "all" && job.provider_id !== provider) return false;
      const jobAccount = job.worker_id ? accountByWorker.get(job.worker_id) : undefined;
      if (account === "unassigned" && jobAccount) return false;
      if (account !== "all" && account !== "unassigned" && jobAccount?.id !== account) return false;
      if (kind !== "all" && job.kind !== kind) return false;
      if (model !== "all" && job.model !== model) return false;
      if (worker !== "all" && job.worker_id !== worker) return false;
      if (!matchesPeriod(job.api_completed_at || job.updated_at, period)) return false;
      if (!normalized) return true;
      return [job.id, job.request_id, job.provider_id, job.model, job.worker_id, job.error_details?.code, job.error_details?.message, job.error_code]
        .some((value) => String(value || "").toLowerCase().includes(normalized));
    });
  }, [account, accountByWorker, jobs, kind, model, period, provider, query, speed, status, worker]);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailLoading(true);
    setDetailError("");
    void getJobDetail(detailId)
      .then((value) => { if (!cancelled) setDetail(value); })
      .catch((reason) => { if (!cancelled) setDetailError(reason instanceof Error ? reason.message : t("Не удалось загрузить запрос")); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [detailId, detailRevision]);

  async function refresh() {
    setRefreshing(true);
    try { await reloadStatus(); } finally { setRefreshing(false); }
  }

  function closeDetail() {
    const next = new URLSearchParams(searchParams);
    next.delete("job");
    setSearchParams(next, { replace: true });
  }

  function setFilter(name: string, value: string, defaultValue = "all") {
    const next = new URLSearchParams(searchParams);
    if (!value || value === defaultValue) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  }

  function resetFilters() {
    const next = new URLSearchParams(searchParams);
    ["q", "status", "speed", "provider", "account", "kind", "model", "worker", "period"].forEach((name) => next.delete(name));
    setSearchParams(next, { replace: true });
  }

  function applyPreset(preset: "active" | "failed" | "today" | "slow") {
    const next = new URLSearchParams(searchParams);
    next.delete("status");
    next.delete("period");
    next.delete("speed");
    if (preset === "today") next.set("period", "today");
    else if (preset === "slow") next.set("speed", "slow");
    else next.set("status", preset);
    setSearchParams(next, { replace: true });
  }

  function openJob(jobId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("job", jobId);
    setSearchParams(next);
  }

  return (
    <>
      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><CardTitle className="flex items-center gap-2"><Activity className="size-4" />{t("Запросы")}</CardTitle><CardDescription>{t("Полный путь API → Chrome → провайдер → результат ·")} {jobs.length} {t("последних · обновление каждые 3 секунды")}</CardDescription></div>
            <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshing} aria-label={t("Обновить")}>
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
          </div>
          <FilterBar
            shown={filtered.length}
            total={jobs.length}
            active={filtersActive}
            onReset={resetFilters}
            presets={
              <>
                <Button type="button" size="sm" variant={status === "active" ? "secondary" : "ghost"} onClick={() => applyPreset("active")}>{t("Активные")}</Button>
                <Button type="button" size="sm" variant={status === "failed" ? "secondary" : "ghost"} onClick={() => applyPreset("failed")}>{t("С ошибкой")}</Button>
                <Button type="button" size="sm" variant={period === "today" ? "secondary" : "ghost"} onClick={() => applyPreset("today")}>{t("Сегодня")}</Button>
                <Button type="button" size="sm" variant={speed === "slow" ? "secondary" : "ghost"} onClick={() => applyPreset("slow")}>{t("Медленные")}</Button>
              </>
            }
          >
            <div className="relative min-w-64 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setFilter("q", event.target.value, "")} placeholder={t("ID запроса, модель или ошибка")} className="pl-8" />
            </div>
            <Select value={status} onValueChange={(value) => setFilter("status", value)}><SelectTrigger aria-label={t("Статус")} className="w-full lg:w-40"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(statusFilterLabels).map(([value, label]) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}</SelectContent></Select>
            <Select value={provider} onValueChange={(value) => setFilter("provider", value)}><SelectTrigger aria-label={t("Провайдер")} className="w-full lg:w-40"><SelectValue placeholder={t("Провайдер")} /></SelectTrigger><SelectContent><SelectItem value="all">{t("Все провайдеры")}</SelectItem>{providers.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={account} onValueChange={(value) => setFilter("account", value)}><SelectTrigger aria-label={t("Chrome-профиль")} className="w-full lg:w-52"><SelectValue placeholder={t("Chrome-профиль")} /></SelectTrigger><SelectContent><SelectItem value="all">{t("Все Chrome-профили")}</SelectItem><SelectItem value="unassigned">{t("Не назначен")}</SelectItem>{accounts.map((item) => <SelectItem key={item.id} value={item.id}>{t(item.label)}</SelectItem>)}</SelectContent></Select>
            <Select value={kind} onValueChange={(value) => setFilter("kind", value)}><SelectTrigger aria-label={t("Тип")} className="w-full lg:w-36"><SelectValue placeholder={t("Тип")} /></SelectTrigger><SelectContent><SelectItem value="all">{t("Все типы")}</SelectItem>{kinds.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={model} onValueChange={(value) => setFilter("model", value)}><SelectTrigger aria-label={t("Модель")} className="w-full lg:w-48"><SelectValue placeholder={t("Модель")} /></SelectTrigger><SelectContent><SelectItem value="all">{t("Все модели")}</SelectItem>{models.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={worker} onValueChange={(value) => setFilter("worker", value)}><SelectTrigger aria-label={t("Исполнитель")} className="w-full lg:w-44"><SelectValue placeholder={t("Исполнитель")} /></SelectTrigger><SelectContent><SelectItem value="all">{t("Все исполнители")}</SelectItem>{workers.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
            <Select value={period} onValueChange={(value) => setFilter("period", value)}><SelectTrigger aria-label={t("Период")} className="w-full lg:w-44"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(periodLabels).map(([value, label]) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}</SelectContent></Select>
            <Select value={speed} onValueChange={(value) => setFilter("speed", value)}><SelectTrigger aria-label={t("Скорость")} className="w-full lg:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t("Любая скорость")}</SelectItem><SelectItem value="slow">{t("Дольше 10 секунд")}</SelectItem></SelectContent></Select>
          </FilterBar>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead className="hidden sm:table-cell">{t("Время")}</TableHead><TableHead>{t("Тип")}</TableHead><TableHead>{t("Провайдер / модель")}</TableHead><TableHead className="hidden lg:table-cell">{t("Аккаунт / исполнитель")}</TableHead><TableHead>{t("Выполнение")}</TableHead><TableHead>{t("Время выполнения")}</TableHead><TableHead><span className="sr-only">{t("Открыть")}</span></TableHead></TableRow></TableHeader>
            <TableBody>
              {filtered.map((job) => (
                <TableRow key={job.id} className="cursor-pointer" onClick={() => openJob(job.id)}>
                  <TableCell className="hidden whitespace-nowrap text-xs text-muted-foreground sm:table-cell">{formatTimestamp(job.api_completed_at || job.updated_at)}</TableCell>
                  <TableCell><div className="flex flex-col gap-1"><Badge variant="outline">{job.kind || "—"}</Badge></div></TableCell>
                  <TableCell><p className="text-sm">{job.provider_id}</p><p className="max-w-64 truncate font-mono text-xs text-muted-foreground">{job.model || "—"}</p></TableCell>
                  <TableCell className="hidden max-w-56 lg:table-cell"><p className="truncate text-xs">{job.worker_id ? accountByWorker.get(job.worker_id)?.email || t("Аккаунт недоступен") : t("Не назначен")}</p><p className="truncate font-mono text-xs text-muted-foreground">{job.worker_id || "—"}</p></TableCell>
                  <TableCell><div className="flex flex-col items-start gap-1">{statusBadge(job.status)}{job.error_details?.code || job.error_code ? <span className="text-xs text-destructive">{job.error_details?.code || job.error_code}</span> : null}</div></TableCell>
                  <TableCell><div className="flex flex-col items-start gap-1"><span className="text-xs text-muted-foreground">{formatDuration(job.duration_ms)}</span></div></TableCell>
                  <TableCell className="text-right"><Button variant="ghost" size="icon" aria-label={t("Открыть {{v0}}", {v0: job.id})}><Eye className="size-4" /></Button></TableCell>
                </TableRow>
              ))}
              {!filtered.length ? <TableRow><TableCell colSpan={7} className="h-36 text-center"><div className="flex flex-col items-center gap-2 text-muted-foreground"><Inbox className="size-6" /><span className="text-sm">{t("Запросы не найдены")}</span></div></TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={Boolean(detailId)} onOpenChange={(open) => { if (!open) closeDetail(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader><DialogTitle>{t("Диагностика запроса")}</DialogTitle><DialogDescription className="break-all">{detail?.request_id || detailId}</DialogDescription></DialogHeader>
          {detailLoading && !detail ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("Загрузка…")}</div> : null}
          {detailError ? <Alert variant="destructive"><AlertDescription>{detailError}</AlertDescription></Alert> : null}
          {detail ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Статус")}</p><div className="mt-1">{statusBadge(detail.status)}</div></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Полное время")}</p><p className="mt-1 text-sm font-medium">{formatDuration(detail.duration_ms)}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Провайдер")}</p><p className="mt-1 text-sm font-medium">{detail.provider_id}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Аккаунт")}</p><p className="mt-1 break-all text-sm font-medium">{detail.worker_id ? accountByWorker.get(detail.worker_id)?.email || t("Аккаунт недоступен") : t("Не назначен")}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Исполнитель")}</p><p className="mt-1 break-all font-mono text-xs">{detail.worker_id || "—"}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Создан")}</p><p className="mt-1 text-sm">{formatTimestamp(detail.created_at)}</p></div>
                <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{t("Ответ завершён")}</p><p className="mt-1 text-sm">{formatTimestamp(detail.api_completed_at)}</p></div>
              </div>
              {detail.error_details?.code || detail.error_code || detail.error ? <Alert variant="destructive"><AlertTitle>{detail.error_details?.code || detail.error_code || t("Ошибка")}</AlertTitle><AlertDescription>{detail.error_details?.message || detail.error || t("Запрос завершился с ошибкой")}</AlertDescription></Alert> : null}
              {Object.keys(detail.error_details || {}).length ? (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{t("Ошибка провайдера")}</p>
                  <JsonBlock title={t("JSON ошибки")} value={detail.error_details} />
                </div>
              ) : null}
              <JsonBlock title={t("Запрос провайдеру")} value={detail.request} />
              {detail.attempts?.length ? <JsonBlock title={t("Попытки и причины переключения")} value={detail.attempts} /> : null}
              {detail.result !== undefined ? <JsonBlock title={t("Результат")} value={detail.result} /> : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
