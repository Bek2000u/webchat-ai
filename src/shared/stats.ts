import type { ModelType, ProviderId } from "./contracts.js";

export type StatsWindow = "6h" | "24h" | "7d";
export type StatsErrorGroup = "code" | "model" | "operation";
export interface StatsQuery {
  window: StatsWindow;
  provider: ProviderId | "all";
  groupBy: StatsErrorGroup;
}
export interface StatsSummary {
  total: number;
  finished: number;
  succeeded: number;
  failed: number;
  pending: number;
  running: number;
  successRate: number | null;
  averageDurationMs: number | null;
  durationSamples: number;
}
export interface OperationStat extends StatsSummary {
  operation: ModelType;
}
export interface ErrorStat {
  key: string;
  count: number;
  total: number;
  errorRate: number;
}
export interface OperationStats extends StatsQuery {
  from: string;
  to: string;
  summary: StatsSummary;
  operations: OperationStat[];
  errors: ErrorStat[];
  coverage: {
    limit: number;
    scanned: number;
    limitReached: boolean;
    oldestCreatedAt: string | null;
    timeBasis: "created_at";
  };
}
