import { AudioLines, Bot, Check, Copy, Download, ExternalLink, Image as ImageIcon, Loader2, Video } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { generatorDownloadName, generatorMediaKind } from "../../lib/generator-output.js";
import type { GenerationResult, MediaPart, ModelKind } from "../../types/generation.js";

const ICONS = { text: Bot, image: ImageIcon, video: Video, audio: AudioLines };

async function copy(value: string) {
  try { await navigator.clipboard.writeText(value); toast.success("Скопировано"); }
  catch { toast.error("Не удалось скопировать. Выделите текст вручную."); }
}

function OutputPart({ part, kind, index }: { part: MediaPart; kind: ModelKind; index: number }) {
  const source = part.dataUrl || part.url;
  const mediaKind = generatorMediaKind(part, kind);
  if (!source) return part.text !== undefined ? (
    <article className="rounded-xl border bg-background">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">Ответ</span>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy(part.text!)}><Copy aria-hidden="true" />Копировать</Button>
      </div>
      <div className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-5 text-sm leading-7" tabIndex={0}>{part.text}</div>
    </article>
  ) : null;
  return (
    <article className="min-w-0 overflow-hidden rounded-xl border bg-background">
      <div className="flex min-h-48 items-center justify-center bg-muted/15 p-3">
        {mediaKind === "image" ? <img src={source} alt={`Сгенерированное изображение ${index + 1}`} className="max-h-[65vh] max-w-full rounded-lg object-contain" />
          : mediaKind === "video" ? <video controls preload="metadata" src={source} className="max-h-[65vh] w-full rounded-lg" aria-label={`Сгенерированное видео ${index + 1}`} />
          : mediaKind === "audio" ? <div className="w-full max-w-lg space-y-5 py-8"><AudioLines className="mx-auto size-12 text-muted-foreground" aria-hidden="true" /><audio controls preload="metadata" src={source} className="w-full" aria-label={`Сгенерированная речь ${index + 1}`} /></div>
          : <p className="text-sm text-muted-foreground">Готовый файл</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1 border-t px-3 py-2">
        {part.url ? <Button type="button" variant="ghost" size="sm" onClick={() => void copy(new URL(part.url!, location.href).href)}><Copy aria-hidden="true" />Ссылка</Button> : null}
        <Button variant="ghost" size="sm" asChild><a href={source} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" />Открыть</a></Button>
        <Button variant="outline" size="sm" asChild><a href={source} download={generatorDownloadName(part, mediaKind, index)}><Download aria-hidden="true" />Скачать</a></Button>
      </div>
    </article>
  );
}

export function GeneratorOutput({ busy, result, kind, elapsedMs }: {
  busy: boolean; result: GenerationResult | null; kind: ModelKind; elapsedMs: number;
}) {
  const Icon = ICONS[kind];
  const json = result?.payload ? JSON.stringify(result.payload, null, 2) : result?.rawText || "{}";
  return (
    <section aria-label="Результат генерации" aria-busy={busy} className="flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card lg:min-h-[calc(100vh-10rem)]">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2"><Icon className="size-4 text-muted-foreground" aria-hidden="true" /><h2 className="text-sm font-semibold">Результат</h2>{result?.ok ? <Badge variant="secondary"><Check className="mr-1 size-3" aria-hidden="true" />Готово</Badge> : null}</div>
        {busy ? <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{(elapsedMs / 1000).toFixed(1)} с</span>
          : result ? <span className="text-xs text-muted-foreground">{(result.durationMs / 1000).toFixed(1)} с · {result.parts.length} {kind === "text" ? "ответ" : "файлов"}</span> : null}
      </div>
      {busy || !result ? (
        <div className="flex min-h-80 flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          {busy ? <Loader2 className="mb-5 size-9 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" /> : <Icon className="mb-5 size-12 text-muted-foreground/60" aria-hidden="true" />}
          <h3 className="text-base font-medium">{busy ? "Генерация выполняется" : "Создайте первый результат"}</h3>
          <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{busy ? "Запрос отправлен в ваш Chrome. Готовый результат появится здесь; время ожидания зависит от сайта." : "Выберите тип, провайдера и параметры. Здесь появится настоящий ответ или готовое медиа."}</p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-4 p-4">
          {!result.ok ? <Alert variant="destructive" role="alert"><AlertDescription>{result.errorMessage || "Провайдер не смог завершить генерацию"}</AlertDescription></Alert> : null}
          <div className={`grid min-w-0 gap-4 ${result.parts.length > 1 && kind === "image" ? "xl:grid-cols-2" : ""}`}>
            {result.parts.map((part, index) => <OutputPart key={`${result.responseId}-${index}`} part={part} kind={kind} index={index} />)}
          </div>
          {result.ok && !result.parts.length ? <p className="text-sm text-muted-foreground">Ответ получен без текста и файлов. Подробности доступны ниже.</p> : null}
          <details className="mt-auto rounded-lg border bg-muted/10 text-xs">
            <summary className="cursor-pointer px-3 py-3 font-medium">Детали API · HTTP {result.httpStatus}{result.responseId ? ` · ${result.responseId}` : ""}</summary>
            <div className="border-t p-3"><Button type="button" variant="ghost" size="sm" className="mb-2" onClick={() => void copy(json)}><Copy aria-hidden="true" />Копировать JSON</Button><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{json}</pre></div>
          </details>
        </div>
      )}
    </section>
  );
}
