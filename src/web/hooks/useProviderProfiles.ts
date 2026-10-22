import { t, localeTag } from "../i18n.js";
import { useState } from "react";
import { toast } from "sonner";
import { revokeAccount, setProviderWorkerEnabled } from "../api/app.js";
import { useAppDataContext } from "../AppContext.js";
import { createDemoAccounts, isDemoAccountId, isDemoWorkerId } from "../lib/demo-accounts.js";
import type { ProviderWorker } from "../../shared/contracts.js";

export function useProviderProfiles() {
  const { accounts, jobs, stats, reloadStatus } = useAppDataContext();
  const [demo, setDemo] = useState(() => import.meta.env.DEV ? createDemoAccounts() : []);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const usingDemo = import.meta.env.DEV && accounts.length === 0;
  async function toggle(worker: ProviderWorker, enabled: boolean) {
    if (isDemoWorkerId(worker.id)) {
      setDemo(current => current.map(profile => ({ ...profile, providers: profile.providers.map(item =>
        item.id === worker.id ? { ...item, enabled } : item) })));
      return;
    }
    setBusy(current => new Set(current).add(worker.id));
    try { await setProviderWorkerEnabled(worker.id, enabled); await reloadStatus(); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("Не удалось изменить провайдер")); }
    finally { setBusy(current => { const next = new Set(current); next.delete(worker.id); return next; }); }
  }
  async function remove(id: string) {
    if (!window.confirm(t("Удалить подключение Chrome-профиля и все его провайдеры? Сессии сайтов в Chrome останутся."))) return;
    if (isDemoAccountId(id)) { setDemo(current => current.filter(profile => profile.id !== id)); return; }
    setBusy(current => new Set(current).add(id));
    try { await revokeAccount(id); await reloadStatus(); toast.success(t("Подключение удалено")); }
    catch (error) { toast.error(error instanceof Error ? error.message : t("Не удалось удалить подключение")); }
    finally { setBusy(current => { const next = new Set(current); next.delete(id); return next; }); }
  }
  return { profiles: usingDemo ? demo : accounts, jobs, stats, reloadStatus, usingDemo, busy, toggle, remove };
}
