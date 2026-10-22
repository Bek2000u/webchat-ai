import { apiGet } from "./client.js";
import type { OperationStats, StatsQuery } from "../../shared/stats.js";

export function getOperationStats(query: StatsQuery) {
  return apiGet<OperationStats>("/api/stats/operations?" + new URLSearchParams({ ...query }));
}
