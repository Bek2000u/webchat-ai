import {
  Activity,
  AudioLines,
  CircleUserRound,
  Clock3,
  Image,
  KeyRound,
  MessageSquareText,
  Server,
  Video,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useAppDataContext } from "../AppContext.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { type BrokerJobStatus, type JobStatus, type ModelType } from "../../shared/contracts.js";
import { StatsCard } from "../components/dashboard/StatsCard.js";

function formatTime(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ru-RU");
}

const kindCards = [
  { kind: "text" as const, label: "Текст", icon: MessageSquareText },
  { kind: "image" as const, label: "Изображения", icon: Image },
  { kind: "video" as const, label: "Видео", icon: Video },
  { kind: "audio" as const, label: "Аудио", icon: AudioLines }
];

const jobLabels: Record<JobStatus, string> = {
  queued: "В очереди",
  claimed: "В работе",
  succeeded: "Готово",
  failed: "Ошибки"
};

const brokerJobStatuses: BrokerJobStatus[] = ["queued", "claimed", "succeeded", "failed"];

function kindStats(stats: ReturnType<typeof useAppDataContext>["stats"], kind: ModelType) {
  return stats?.requests.by_kind[kind] ?? { total: 0, successful: 0, failed: 0 };
}

export function DashboardPage() {
  const { jobs, serverConfig, stats, systemInfo, workers } = useAppDataContext();
  const recentJobs = jobs.slice(0, 6);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kindCards.map(({ kind, label, icon: Icon }) => {
          const values = kindStats(stats, kind);
          return (
            <StatsCard key={kind} title={label} value={values.total} icon={Icon} />
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="size-4" />Завершённые запросы</CardTitle>
            <CardDescription>Итоговая статистика запросов с выполнением в Chrome</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-muted p-3"><p className="text-xl font-semibold">{stats?.requests.total ?? 0}</p><p className="text-xs text-muted-foreground">Всего</p></div>
            <div className="rounded-lg bg-muted p-3"><p className="text-xl font-semibold">{stats?.requests.successful ?? 0}</p><p className="text-xs text-muted-foreground">Успешно</p></div>
            <div className="rounded-lg bg-muted p-3"><p className="text-xl font-semibold">{stats?.requests.failed ?? 0}</p><p className="text-xs text-muted-foreground">Ошибок</p></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Clock3 className="size-4" />Состояние выполнения</CardTitle>
            <CardDescription>Текущая очередь и внутренние статусы запросов</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            {brokerJobStatuses.map((status) => (
              <div key={status} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span className="text-muted-foreground">{jobLabels[status]}</span>
                <span className="font-semibold">{stats?.jobs[status] ?? 0}</span>
              </div>
            ))}
            <Button asChild variant="outline" className="col-span-2"><Link to="/requests">Открыть диагностику</Link></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Server className="size-4" />Система</CardTitle>
            <CardDescription>Сервер, расширение и подключения</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Исполнители</span><span>{stats?.workers.online ?? 0}/{stats?.workers.total ?? 0} в сети</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Сервер</span><span>{systemInfo?.version || "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Расширение</span><span className="truncate">{serverConfig?.extensionVersion || "—"}</span></div>
            <div className="flex justify-between gap-3"><span className="text-muted-foreground">Ключ API</span><Badge variant={serverConfig?.apiKeyConfigured ? "default" : "destructive"}>{serverConfig?.apiKeyConfigured ? "настроен" : "не настроен"}</Badge></div>
            <Button asChild variant="outline" className="w-full"><Link to="/accounts"><CircleUserRound />Профили Chrome</Link></Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div><CardTitle>Последние запросы</CardTitle><CardDescription>Статусы обновляются каждые 3 секунды</CardDescription></div>
          <Button asChild variant="outline" size="sm"><Link to="/requests">Все запросы</Link></Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {recentJobs.length === 0 ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Запросов пока нет.</p>
          ) : recentJobs.map((job) => (
            <Link key={job.id} to={`/requests?job=${encodeURIComponent(job.id)}`} className="grid gap-2 rounded-lg border px-3 py-2.5 hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0"><p className="truncate text-sm font-medium">{job.model || job.id}</p><p className="text-xs text-muted-foreground">{job.provider_id} · {formatTime(job.updated_at)}</p></div>
              <Badge
                variant={job.status === "failed" ? "destructive" : job.status === "succeeded" ? "default" : "secondary"}
              >
                {jobLabels[job.status]}
              </Badge>
            </Link>
          ))}
        </CardContent>
      </Card>

      {(stats?.jobs.queued ?? 0) > 0 && workers.every((worker) => !worker.online) ? (
        <div className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
          <Clock3 className="size-4" />В очереди {stats?.jobs.queued} запросов, но нет доступных исполнителей провайдеров.
        </div>
      ) : null}

      {!serverConfig?.apiKeyConfigured ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 px-4 py-3 text-sm">
          <KeyRound className="size-4 text-destructive" />Создайте API-ключ для клиентских приложений.
        </div>
      ) : null}
    </div>
  );
}
