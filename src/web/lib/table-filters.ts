
export type PeriodFilter = "all" | "hour" | "today" | "7d";

export function matchesPeriod(value: string | null | undefined, period: PeriodFilter) {
  if (period === "all") return true;

  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) return false;

  const now = Date.now();
  if (period === "hour") return timestamp >= now - 60 * 60 * 1000;
  if (period === "7d") return timestamp >= now - 7 * 24 * 60 * 60 * 1000;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return timestamp >= startOfToday.getTime();
}

export function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((left, right) =>
    left.localeCompare(right, "ru")
  );
}

export function isPeriodFilter(value: string | null): value is PeriodFilter {
  return value === "all" || value === "hour" || value === "today" || value === "7d";
}
