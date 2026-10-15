import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "../ui/card.js";

export function StatsCard({ title, value, icon: Icon }: {
  title: string;
  value: number | string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 pt-4">
        <dl className="min-w-0 space-y-2">
          <dt className="text-sm text-muted-foreground">{title}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
        </dl>
        <Icon aria-hidden="true" className="mt-1 size-5 shrink-0 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}
