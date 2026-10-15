import { useEffect, useState } from "react";
import { CheckCheck, CircleCheck, CircleX, Clock3, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { PROVIDERS } from "../../shared/contracts.js";
import type { OperationStats, StatsErrorGroup, StatsQuery, StatsWindow } from "../../shared/stats.js";
import { getOperationStats } from "../api/stats.js";
import { operationLabels, statsDuration, statsPercent } from "../lib/stats.js";
import { StatsCard } from "../components/dashboard/StatsCard.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

const windows: Record<StatsWindow, string> = { "6h": "Последние 6 часов", "24h": "Последние 24 часа", "7d": "Последние 7 дней" };
const groups: Record<StatsErrorGroup, string> = { code: "Код", model: "Модель", operation: "Операция" };
function formatDate(value: string) { return new Date(value).toLocaleString("ru-RU"); }

export function StatsPage() {
  const [window, setWindow] = useState<StatsWindow>("6h");
  const [provider, setProvider] = useState<StatsQuery["provider"]>("all");
  const [groupBy, setGroupBy] = useState<StatsErrorGroup>("code");
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<OperationStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setData(null);
    void getOperationStats({ window, provider, groupBy }).then((result) => {
      if (active) setData(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Не удалось загрузить статистику");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [window, provider, groupBy, refresh]);
  const largestDuration = Math.max(0, ...(data?.operations.map((operation) => operation.averageDurationMs ?? 0) ?? []));

  return <div className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-end gap-3">
      <div className="space-y-1.5"><label className="text-xs text-muted-foreground" htmlFor="stats-window">Период</label>
        <Select value={window} onValueChange={(value) => setWindow(value as StatsWindow)}><SelectTrigger id="stats-window" className="min-w-44"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(windows).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select>
      </div>
      <div className="space-y-1.5"><label className="text-xs text-muted-foreground" htmlFor="stats-provider">Провайдер</label>
        <Select value={provider} onValueChange={(value) => setProvider(value as StatsQuery["provider"])}><SelectTrigger id="stats-provider" className="min-w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Все провайдеры</SelectItem>{Object.values(PROVIDERS).map((value) => <SelectItem key={value.id} value={value.id}>{value.label}</SelectItem>)}</SelectContent></Select>
      </div>
      <Button type="button" variant="outline" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>{loading ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw className="size-4" aria-hidden="true" />}Обновить</Button>
    </div>
    {error && <Alert variant="destructive"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert>}
    {loading && <p className="py-8 text-center text-sm text-muted-foreground" role="status">Загрузка статистики…</p>}
    {data && <>
      {data.coverage.limitReached && <Alert><TriangleAlert aria-hidden="true" /><AlertDescription>Достигнут лимит {data.coverage.limit.toLocaleString("ru-RU")} последних запросов журнала. Статистика выбранного периода может быть неполной.</AlertDescription></Alert>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatsCard title="Завершено" value={data.summary.finished} icon={CheckCheck} />
        <StatsCard title="Успешно" value={statsPercent(data.summary.successRate)} icon={CircleCheck} />
        <StatsCard title="Ошибки" value={data.summary.failed} icon={CircleX} />
        <StatsCard title="Среднее время" value={statsDuration(data.summary.averageDurationMs)} icon={Clock3} />
      </div>
      <p className="text-sm text-muted-foreground">Всего {data.summary.total} · Успешно {data.summary.succeeded} · В очереди {data.summary.pending} · В работе {data.summary.running}</p>
      {data.summary.total === 0 && <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">В выбранном периоде нет запросов этого провайдера.</p>}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <Card className="min-w-0"><CardHeader><CardTitle>Время по операциям</CardTitle><CardDescription>Среднее время запроса целиком: очередь, генерация, повторы и получение результата. Только завершённые запросы.</CardDescription></CardHeader>
          <CardContent><dl className="space-y-5">{data.operations.map((operation) => <div key={operation.operation} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3"><dt className="text-sm">{operationLabels[operation.operation]} <span className="text-xs text-muted-foreground">· {operation.finished}</span></dt><dd className="shrink-0 text-sm font-medium tabular-nums">{statsDuration(operation.averageDurationMs)}</dd></div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-primary" style={{ width: `${largestDuration ? (operation.averageDurationMs ?? 0) / largestDuration * 100 : 0}%` }} /></div>
          </div>)}</dl></CardContent>
        </Card>
        <Card className="min-w-0"><CardHeader><CardTitle>Ошибки</CardTitle><CardDescription>{groupBy === "code" ? "Доля каждого кода среди всех завершённых запросов." : "Доля ошибок среди завершённых запросов соответствующей модели или операции."}</CardDescription>
          <div className="flex flex-wrap gap-1 pt-2" role="group" aria-label="Группировка ошибок">{Object.entries(groups).map(([value, label]) => <Button key={value} type="button" size="sm" variant={groupBy === value ? "secondary" : "ghost"} aria-pressed={groupBy === value} onClick={() => setGroupBy(value as StatsErrorGroup)}>{label}</Button>)}</div>
        </CardHeader><CardContent>
          {data.errors.length ? <Table className="table-fixed"><TableHeader><TableRow><TableHead className="w-1/2">{groups[groupBy]}</TableHead><TableHead className="whitespace-normal text-right text-xs">Ошибок / завершено</TableHead><TableHead className="whitespace-normal text-right text-xs">Доля</TableHead></TableRow></TableHeader><TableBody>{data.errors.map((entry) => <TableRow key={entry.key}><TableCell className="break-all whitespace-normal text-xs font-medium">{groupBy === "operation" ? operationLabels[entry.key as keyof typeof operationLabels] ?? entry.key : entry.key}</TableCell><TableCell className="text-right tabular-nums">{entry.count} / {entry.total}</TableCell><TableCell className="text-right tabular-nums">{statsPercent(entry.errorRate)}</TableCell></TableRow>)}</TableBody></Table> : <p className="py-6 text-center text-sm text-muted-foreground">Ошибок нет.</p>}
        </CardContent></Card>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">Запросы, созданные с {formatDate(data.from)} по {formatDate(data.to)}. Просмотрено {data.coverage.scanned.toLocaleString("ru-RU")} записей журнала, максимум {data.coverage.limit.toLocaleString("ru-RU")}. Провайдер и модель — по последней попытке. Время не является latency провайдера; среднее рассчитано по {data.summary.durationSamples} завершённым запросам с корректными датами.</p>
    </>}
  </div>;
}
