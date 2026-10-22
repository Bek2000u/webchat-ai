import { t, localeTag } from "../../i18n.js";
import { Filter, RotateCcw } from "lucide-react";
import { type ReactNode } from "react";
import { Button } from "../ui/button.js";

type FilterBarProps = {
  children: ReactNode;
  shown: number;
  total: number;
  active: boolean;
  onReset: () => void;
  presets?: ReactNode;
};

export function FilterBar({ children, shown, total, active, onReset, presets }: FilterBarProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Filter className="size-4 text-muted-foreground" />
          {t("Фильтры")}
        </div>
        {presets ? <div className="flex flex-wrap items-center gap-1">{presets}</div> : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("Показано")} {shown} {t("из")} {total}</span>
          {active ? (
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              <RotateCcw className="size-3.5" />{t("Сбросить")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap">{children}</div>
    </div>
  );
}
