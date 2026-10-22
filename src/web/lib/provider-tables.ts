import { t, localeTag } from "../i18n.js";
import { MODELS, PROVIDERS, type Account, type JobRow, type ProviderWorker } from "../../shared/contracts.js";

export type ProviderSlot = { profile: Account; worker: ProviderWorker };
export function providerLabel(id: string) { return PROVIDERS[id as keyof typeof PROVIDERS]?.label ?? id; }
export function profileLabel(profile: Account) {
  return profile.label && profile.label !== profile.id ? profile.label : t("Профиль {{v0}}", {v0: profile.id.slice(-6)});
}
export function providerSlots(profiles: Account[]): ProviderSlot[] {
  return profiles.flatMap(profile => profile.providers.map(worker => ({ profile, worker })));
}
export function workerAvailable(worker: ProviderWorker) {
  return worker.enabled && worker.online && (worker.status === "ready" || worker.status === "busy");
}
export function slotIdentity({ worker }: ProviderSlot) { return worker.account_subject || t("Не определён"); }
export function matchesSlot(slot: ProviderSlot, query: string) {
  const value = query.trim().toLocaleLowerCase();
  return !value || [profileLabel(slot.profile), slot.profile.chrome_email, slot.profile.id,
    slotIdentity(slot), providerLabel(slot.worker.provider_id), slot.worker.connection_error?.message,
    slot.worker.health?.lastError?.error.message].some(item => item?.toLocaleLowerCase().includes(value));
}
/** Pending work is not assigned to a profile. Never sum worker.queued_jobs. */
export function pendingCounts(jobs: JobRow[]) {
  const providers: Record<string, number> = {};
  let auto = 0;
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.status !== "queued" || seen.has(job.id)) continue;
    seen.add(job.id);
    if (job.model === "auto") { auto++; continue; }
    const provider = job.provider_id || MODELS.find(model => model.id === job.model)?.providerId;
    if (provider) providers[provider] = (providers[provider] || 0) + 1;
  }
  return { providers, auto };
}
export function latestTimestamp(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => !!value).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
export function timeLabel(value?: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(localeTag());
}
