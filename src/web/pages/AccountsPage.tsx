import { t, localeTag } from "../i18n.js";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, Chrome, MoreHorizontal, RefreshCw, Trash2, Wifi, WifiOff } from "lucide-react";
import { useProviderProfiles } from "../hooks/useProviderProfiles.js";
import { matchesSlot, latestTimestamp, profileLabel, providerSlots, timeLabel, workerAvailable } from "../lib/provider-tables.js";
import { ProviderProfilesTable } from "../components/providers/ProviderProfilesTable.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.js";

export function AccountsPage() {
  const { profiles, usingDemo, busy, toggle, remove, reloadStatus } = useProviderProfiles();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const visible = profiles.filter(profile => !query.trim() || providerSlots([profile]).some(slot => matchesSlot(slot, query)) || profileLabel(profile).toLowerCase().includes(query.trim().toLowerCase()));
  function expand(id: string) { setExpanded(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 text-base font-semibold"><Chrome className="size-4" aria-hidden="true" />{profiles.length} {t("подключений")} {usingDemo && <Badge variant="outline">{t("Демо")}</Badge>}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("Аккаунты сайтов находятся внутри каждого Chrome-профиля")}</p></div>
      <Button variant="outline" size="icon" onClick={() => void reloadStatus()} aria-label={t("Обновить данные")}><RefreshCw className="size-4" aria-hidden="true" /></Button></div>
    <Input aria-label={t("Поиск профиля или аккаунта сайта")} placeholder={t("Найти профиль, email или провайдера…")} value={query} onChange={event => setQuery(event.target.value)} className="max-w-sm" />
    <div className="overflow-hidden rounded-lg border"><Table><TableHeader><TableRow><TableHead><span className="sr-only">{t("Раскрыть")}</span></TableHead><TableHead>{t("Chrome-профиль")}</TableHead><TableHead>Chrome email</TableHead><TableHead>{t("Соединение")}</TableHead><TableHead>{t("Провайдеры")}</TableHead><TableHead>{t("В работе")}</TableHead><TableHead>{t("Активность")}</TableHead><TableHead><span className="sr-only">{t("Действия")}</span></TableHead></TableRow></TableHeader>
      <TableBody>{visible.map(profile => {
        const open = expanded.has(profile.id), online = profile.providers.some(worker => worker.online);
        const slots = providerSlots([profile]);
        return <Fragment key={profile.id}><TableRow className="text-sm">
          <TableCell className="w-10"><Button variant="ghost" size="icon-sm" onClick={() => expand(profile.id)} aria-expanded={open} aria-controls={`profile-${profile.id}`} aria-label={t("{{v0}} провайдеры {{v1}}", {v0: open ? t("Скрыть") : t("Показать"), v1: profileLabel(profile)})}>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</Button></TableCell>
          <TableCell className="font-medium"><button className="cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => expand(profile.id)} aria-expanded={open}>{profileLabel(profile)}</button></TableCell>
          <TableCell className="max-w-52 truncate text-xs" title={profile.chrome_email}>{profile.chrome_email || "—"}</TableCell>
          <TableCell><span className="inline-flex items-center gap-1.5 text-xs">{online ? <Wifi className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /> : <WifiOff className="size-3.5 text-muted-foreground" aria-hidden="true" />}{online ? t("В сети") : t("Не в сети")}</span></TableCell>
          <TableCell className="tabular-nums">{profile.providers.filter(workerAvailable).length}/{profile.providers.length}</TableCell>
          <TableCell className="tabular-nums">{profile.providers.reduce((sum, worker) => sum + worker.active_jobs, 0)}</TableCell>
          <TableCell className="text-xs text-muted-foreground">{timeLabel(latestTimestamp(profile.providers.map(worker => worker.last_seen_at)))}</TableCell>
          <TableCell><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" disabled={busy.has(profile.id)} aria-label={t("Действия {{v0}}", {v0: profileLabel(profile)})}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => void remove(profile.id)}><Trash2 className="size-3.5" aria-hidden="true" />{t("Удалить подключение")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell>
        </TableRow>{open && <TableRow id={`profile-${profile.id}`} className="bg-muted/20 hover:bg-muted/20"><TableCell colSpan={8} className="px-3 py-2"><ProviderProfilesTable slots={slots} busy={busy} onToggle={toggle} /></TableCell></TableRow>}</Fragment>;
      })}{visible.length === 0 && <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">{profiles.length ? t("Ничего не найдено") : t("Установите расширение в Chrome. Профиль подключится автоматически.")}</TableCell></TableRow>}</TableBody></Table></div>
  </div>;
}
