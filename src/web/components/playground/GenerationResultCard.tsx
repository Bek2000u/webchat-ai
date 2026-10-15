import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { Skeleton } from "../ui/skeleton.js";
import { type GenerationResult, type MediaPart } from "../../types/generation.js";

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(1)} с`;
}

function MediaPartView({ part }: { part: MediaPart }) {
  const source = part.dataUrl || part.url;
  if (source) {
    const mimeType = part.mimeType || "application/octet-stream";
    if (mimeType.startsWith("image/")) {
      return <img src={source} alt="Результат генерации" className="max-h-[480px] w-full rounded-lg border border-border bg-muted/20 object-contain" />;
    }
    if (mimeType.startsWith("video/")) {
      return <video controls src={source} className="w-full rounded-lg border border-border bg-black" />;
    }
    if (mimeType.startsWith("audio/")) {
      return <audio controls src={source} className="w-full" />;
    }
    if (part.url) {
      return <a href={part.url} target="_blank" rel="noreferrer" className="text-sm text-primary underline underline-offset-2">Открыть файл ({mimeType})</a>;
    }
    return <p className="text-sm text-muted-foreground">Неизвестный тип данных: {mimeType}</p>;
  }
  return part.text ? <p className="whitespace-pre-wrap text-sm text-foreground">{part.text}</p> : null;
}

function MediaPreview({ parts }: { parts: MediaPart[] }) {
  if (!parts.length) return <p className="text-sm text-muted-foreground">Ответ не содержит медиаданных.</p>;
  return <div className="flex flex-col gap-3">{parts.map((part, index) => <MediaPartView key={index} part={part} />)}</div>;
}

export function GenerationResultCard({ busy, result }: { busy: boolean; result: GenerationResult | null }) {
  const [jsonOpen, setJsonOpen] = useState(false);
  const rawJson = result?.payload ? JSON.stringify(result.payload, null, 2) : result?.rawText || "{}";

  useEffect(() => setJsonOpen(false), [result]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div><CardTitle>Результат</CardTitle><CardDescription>Ответ API и медиа-превью</CardDescription></div>
          {result ? <Badge variant={result.ok ? "secondary" : "destructive"}>{result.ok ? "Успех" : "Ошибка"}</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {busy ? (
          <div className="flex flex-col gap-3"><Skeleton className="h-48 w-full rounded-lg" /><Skeleton className="h-4 w-2/3 rounded" /><Skeleton className="h-4 w-1/2 rounded" /></div>
        ) : !result ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Здесь появится результат генерации</p>
        ) : (
          <div className="flex flex-col gap-4 transition-opacity">
            {!result.ok ? <Alert variant="destructive"><AlertDescription>{result.errorMessage}</AlertDescription></Alert> : null}
            <MediaPreview parts={result.parts} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">HTTP {result.httpStatus}</Badge>
              {result.finishReason ? <Badge variant="outline">{result.finishReason}</Badge> : null}
              {result.responseId ? <Badge variant="outline">{result.responseId}</Badge> : null}
              <Badge variant="outline">{formatSeconds(result.durationMs)}</Badge>
            </div>
            <div className="flex flex-col gap-2">
              <Button type="button" variant="outline" size="sm" className="w-fit gap-1.5" onClick={() => setJsonOpen((value) => !value)}>
                {jsonOpen ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                {jsonOpen ? "Скрыть JSON" : "Показать JSON"}
              </Button>
              {jsonOpen ? <ScrollArea className="h-64 w-full rounded-lg border border-border bg-muted/30"><pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs text-foreground">{rawJson}</pre></ScrollArea> : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
