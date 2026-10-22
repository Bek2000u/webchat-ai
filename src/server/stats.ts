import { z } from "zod";
import { modelSpec, PROVIDERS, type ProviderId, type RequestRecord, type ModelType } from "../shared/contracts.js";
import type { OperationStats, StatsQuery, StatsSummary } from "../shared/stats.js";

export const STATS_RECORD_LIMIT = 100000;
const durations = { "6h": 6 * 3600000, "24h": 24 * 3600000, "7d": 7 * 86400000 } as const;
const operations: ModelType[] = ["text", "image", "video", "audio"];
export const statsQuerySchema = z.object({
  window: z.enum(["6h", "24h", "7d"]).default("6h"),
  provider: z.enum(["all", ...Object.keys(PROVIDERS) as ProviderId[]]).default("all"),
  groupBy: z.enum(["code", "model", "operation"]).default("code"),
}).strict();

function terminal(record: RequestRecord) {
  return record.status === "completed" || record.status === "error";
}
function summarize(records: RequestRecord[]): StatsSummary {
  let durationSum = 0, durationSamples = 0, succeeded = 0, failed = 0, pending = 0, running = 0;
  for (const record of records) {
    if (record.status === "completed") succeeded++;
    else if (record.status === "error") failed++;
    else if (record.status === "pending") pending++;
    else if (record.status === "running") running++;
    if (!terminal(record)) continue;
    const duration = Date.parse(record.updatedAt) - Date.parse(record.createdAt);
    if (Number.isFinite(duration) && duration >= 0) { durationSum += duration; durationSamples++; }
  }
  const finished = succeeded + failed;
  return {
    total: records.length, finished, succeeded, failed, pending, running,
    successRate: finished ? succeeded / finished : null,
    averageDurationMs: durationSamples ? durationSum / durationSamples : null,
    durationSamples,
  };
}
function resolvedModel(record: RequestRecord) {
  return record.attempts.at(-1)?.model ?? record.request.options.model;
}
function groupKey(record: RequestRecord, groupBy: StatsQuery["groupBy"]) {
  return groupBy === "operation" ? record.request.kind
    : groupBy === "model" ? resolvedModel(record)
    : record.error?.code || "UNKNOWN_ERROR";
}

/** Request end-to-end metrics from a bounded journal, never provider-only latency. */
export function operationStats(records: RequestRecord[], query: StatsQuery, now = Date.now(), limit = STATS_RECORD_LIMIT): OperationStats {
  const from = now - durations[query.window];
  const selected = records.filter((record) => {
    const created = Date.parse(record.createdAt);
    const provider = record.attempts.at(-1)?.provider ?? record.error?.provider ?? modelSpec(record.request.options.model)?.providerId;
    return Number.isFinite(created) && created >= from && created <= now && (query.provider === "all" || query.provider === provider);
  });
  const finished = selected.filter(terminal);
  const errors = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const record of finished) {
    const key = groupKey(record, query.groupBy);
    if (query.groupBy !== "code") totals.set(key, (totals.get(key) ?? 0) + 1);
    if (record.status === "error") errors.set(key, (errors.get(key) ?? 0) + 1);
  }
  const createdDates = records.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite);
  return {
    ...query,
    from: new Date(from).toISOString(), to: new Date(now).toISOString(),
    summary: summarize(selected),
    operations: operations.map((operation) => ({ operation, ...summarize(selected.filter((record) => record.request.kind === operation)) })),
    errors: [...errors].map(([key, count]) => {
      const total = query.groupBy === "code" ? finished.length : totals.get(key)!;
      return { key, count, total, errorRate: count / total };
    }).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    coverage: {
      limit, scanned: records.length, limitReached: records.length >= limit,
      oldestCreatedAt: createdDates.length ? new Date(createdDates.reduce((oldest, value) => Math.min(oldest, value), Infinity)).toISOString() : null,
      timeBasis: "created_at",
    },
  };
}
