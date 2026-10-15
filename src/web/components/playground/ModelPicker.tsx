import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Input } from "../ui/input.js";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { cn } from "../../lib/utils.js";
import { type ModelEntry, type ModelType } from "../../../shared/contracts.js";

const TYPE_LABELS: Record<ModelType, string> = {
  text: "Текст",
  image: "Изображения",
  video: "Видео",
  audio: "Аудио"
};

function providerName(model: ModelEntry) {
  return model.capabilities.providerLabel || model.capabilities.provider;
}

function modelName(model: ModelEntry) {
  return model.displayName?.trim() || model.id;
}

type ModelPickerProps = {
  models: ModelEntry[];
  value: string;
  onValueChange: (value: string) => void;
};

export function ModelPicker({ models, value, onValueChange }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.id === value);
  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    const visible = normalized
      ? models.filter((model) => [model.id, model.displayName, model.capabilities.provider]
        .some((field) => String(field || "").toLocaleLowerCase("ru-RU").includes(normalized)))
      : models;
    return (["text", "image", "video", "audio"] as ModelType[])
      .map((type) => ({ type, models: visible.filter((model) => model.type === type) }))
      .filter((group) => group.models.length > 0);
  }, [models, query]);

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setQuery("");
    }}>
      <PopoverTrigger asChild>
        <Button
          id="tb-model"
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-11 w-full justify-between px-3 py-2 text-left font-normal"
        >
          {selected ? (
            <span className="min-w-0">
              <span className="block truncate font-medium">{modelName(selected)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {selected.id} · {providerName(selected)}
                {!selected.available ? " · нет доступного профиля" : ""}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Выберите модель</span>
          )}
          <ChevronsUpDown className="ml-3 size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] gap-0 p-0">
        <div className="relative border-b p-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти модель или провайдера…"
            className="h-9 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0"
          />
        </div>
        <ScrollArea className="h-80">
          <div className="p-1.5">
            {groups.length ? groups.map((group) => (
              <div key={group.type} className="mb-1 last:mb-0">
                <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{TYPE_LABELS[group.type]}</p>
                {group.models.map((model) => {
                  const active = model.id === value;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                        active && "bg-accent/70"
                      )}
                      onClick={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn("size-4 shrink-0", active ? "opacity-100" : "opacity-0")} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{modelName(model)}</span>
                        <span className="block truncate font-mono text-xs text-muted-foreground">{model.id}</span>
                      </span>
                      <Badge variant="outline" className="max-w-28 shrink-0 truncate font-normal">
                        {model.available ? providerName(model) : "Нет профиля"}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )) : (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">Модели не найдены</p>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
