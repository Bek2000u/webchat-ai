import {
  AudioLines,
  Bot,
  Image as ImageIcon,
  Info,
  Loader2,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { GeneratorOutput } from "../components/playground/GeneratorOutput.js";
import { ModelPicker } from "../components/playground/ModelPicker.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Separator } from "../components/ui/separator.js";
import { Textarea } from "../components/ui/textarea.js";
import { useAppDataContext } from "../AppContext.js";
import { buildGenerationConfig, runGeneration } from "../api/generation.js";
import { generatorModel, generatorModels } from "../lib/generator-output.js";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import {
  VOICE_PITCHES,
  VOICE_PREVIEW_LANGUAGES,
  VOICE_STYLES,
  voicePreviewLanguage,
  type VoiceCatalogEntry,
} from "../../shared/models.js";
import { type ModelEntry } from "../../shared/contracts.js";
import { type GenerationResult, type ModelKind, type VideoMode } from "../types/generation.js";

const ASPECT_LABELS: Record<string, string> = {
  landscape: "Альбомная 16:9",
  portrait: "Портретная 9:16",
  square: "Квадратная 1:1",
  "four-three": "Альбомная 4:3",
  "three-four": "Портретная 3:4"
};

const VIDEO_MODE_LABELS: Record<VideoMode, string> = {
  text: "Только текст",
  start: "Стартовый кадр",
  interpolation: "Первый и последний кадр",
  reference: "Референсные изображения"
};

const KIND_LABEL: Record<ModelKind, string> = {
  text: "Текст",
  image: "Изображение",
  video: "Видео",
  audio: "Аудио"
};

const KIND_ICON: Record<ModelKind, LucideIcon> = {
  text: Bot,
  image: ImageIcon,
  video: Video,
  audio: AudioLines
};

const voiceLanguageNames = new Intl.DisplayNames(["ru"], { type: "language" });
const voiceStyleOptions = Object.entries(VOICE_STYLES).sort((a, b) => a[1].localeCompare(b[1], "ru"));

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

function isVideoMode(value: string): value is VideoMode {
  return value === "text" || value === "start" || value === "interpolation" || value === "reference";
}

function defaultString(defaults: ModelEntry["capabilities"]["defaults"], key: string, fallback = ""): string {
  const value = defaults[key];
  return typeof value === "string" ? value : fallback;
}

function defaultNumber(defaults: ModelEntry["capabilities"]["defaults"], key: string, fallback = 0): number {
  const value = defaults[key];
  return typeof value === "number" ? value : fallback;
}

export function PlaygroundPage() {
  const { models } = useAppDataContext();
  const [kind, setKind] = useState<ModelKind>("text");
  const [model, setModel] = useState(() => generatorModel(models, "text"));
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState("landscape");
  const [imageSize, setImageSize] = useState("1k");
  const [durationSeconds, setDurationSeconds] = useState(8);
  const [videoResolution, setVideoResolution] = useState("720p");
  const [voice, setVoice] = useState("Achird");
  const [voiceEntries, setVoiceEntries] = useState<VoiceCatalogEntry[]>([]);
  const [voiceCatalogError, setVoiceCatalogError] = useState("");
  const [voicePreviewError, setVoicePreviewError] = useState(false);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceStyle, setVoiceStyle] = useState("all");
  const [voicePitch, setVoicePitch] = useState("all");
  const [previewLanguage, setPreviewLanguage] = useState(() => voicePreviewLanguage(navigator.language));
  const [videoMode, setVideoMode] = useState<VideoMode>("text");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [resultKind, setResultKind] = useState<ModelKind>("text");
  const initializedModel = useRef("");

  const selectedModel = useMemo(() => models.find((entry) => entry.id === model), [models, model]);
  const taskModels = useMemo(() => generatorModels(models, kind), [models, kind]);
  const capabilities = selectedModel?.capabilities;
  const aspects = useMemo(() => capabilities?.aspects ?? [], [capabilities]);
  const sizes = useMemo(() => capabilities?.sizes ?? [], [capabilities]);
  const durations = useMemo(() => capabilities?.durations ?? [], [capabilities]);
  const voices = useMemo(() => capabilities?.voices ?? [], [capabilities]);
  const selectedVoicePreview = voiceEntries.find((entry) => entry.voiceId === voice);
  const voiceQuery = voiceSearch.trim().toLowerCase();
  const filteredVoices = voiceEntries.filter((entry) =>
    (voiceStyle === "all" || entry.style === voiceStyle) &&
    (voicePitch === "all" || entry.pitch === voicePitch) &&
    (!voiceQuery || entry.name.toLowerCase().includes(voiceQuery)),
  );
  const videoModes = useMemo(
    () => (capabilities?.modes ?? []).filter(isVideoMode),
    [capabilities]
  );

  useEffect(() => {
    setVoiceEntries([]);
    setVoiceCatalogError("");
    if (kind !== "audio") return;
    const controller = new AbortController();
    const query = new URLSearchParams({ model, language: previewLanguage });
    void fetch(`/v1/audio/voices?${query}`, {
      credentials: "include",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "Не удалось загрузить каталог голосов");
      if (!controller.signal.aborted) setVoiceEntries(payload.voices);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setVoiceCatalogError(error instanceof Error ? error.message : "Не удалось загрузить каталог голосов");
      }
    });
    return () => controller.abort();
  }, [kind, model, previewLanguage]);

  useEffect(() => setVoicePreviewError(false), [voice, model, previewLanguage]);

  useEffect(() => {
    const next = generatorModel(models, kind, model);
    if (next !== model) setModel(next);
  }, [models, kind, model]);

  useEffect(() => {
    // Status polling replaces model objects without changing the user's choice.
    if (!selectedModel || initializedModel.current === selectedModel.id) return;
    initializedModel.current = selectedModel.id;
    const defaults = selectedModel.capabilities.defaults;
    setAspectRatio(defaultString(defaults, "aspect", aspects[0] || ""));
    setImageSize(defaultString(defaults, "size", sizes[0] || ""));
    setDurationSeconds(defaultNumber(defaults, "duration", durations[0] || 0));
    setVideoResolution(defaultString(defaults, "size", sizes[0] || ""));
    setVoice(defaultString(defaults, "voice", voices[0] || ""));
    setVideoMode(videoModes[0] || "text");
    setImageFiles([]);
  }, [aspects, durations, selectedModel, sizes, videoModes, voices]);

  const imageLimits = useMemo(() => {
    if (!capabilities || kind === "audio" || kind === "text") return { min: 0, max: 0 };
    if (kind === "image") return { min: capabilities.minImages, max: capabilities.maxImages };
    return capabilities.modeImageCounts[videoMode] || { min: 0, max: 0 };
  }, [capabilities, kind, videoMode]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 200);
    return () => window.clearInterval(timer);
  }, [busy]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!model) {
      toast.error("Выберите модель");
      return;
    }
    if (!prompt.trim()) {
      toast.error("Введите текст запроса");
      return;
    }
    if (imageFiles.length < imageLimits.min || imageFiles.length > imageLimits.max) {
      const expected = imageLimits.min === imageLimits.max
        ? String(imageLimits.min)
        : `${imageLimits.min}–${imageLimits.max}`;
      toast.error(`Для выбранного режима требуется изображений: ${expected}`);
      return;
    }

    setBusy(true);
    setResult(null);
    setResultKind(kind);

    try {
      const generationConfig = buildGenerationConfig(kind, {
        aspectRatio,
        imageSize,
        videoResolution,
        durationSeconds,
        voice
      });
      const outcome = await runGeneration({
        model,
        kind,
        mode: kind === "video" ? videoMode : undefined,
        prompt: prompt.trim(),
        imageFiles,
        generationConfig
      });
      setResult(outcome);
      if (outcome.ok) {
        toast.success("Генерация завершена");
      } else {
        toast.error(outcome.errorMessage || "Ошибка генерации");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось выполнить запрос";
      setResult({ ok: false, httpStatus: 0, durationMs: 0, payload: null, rawText: "", parts: [], errorMessage: message });
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:items-start">
      <Card className="min-w-0 gap-4 py-4">
        <CardHeader className="px-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>Создать</CardTitle>
              <CardDescription>Ваши подключённые аккаунты Chrome</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-4">
          <Tabs value={kind} onValueChange={(value) => {
            const next = value as ModelKind;
            setKind(next);
            setModel(generatorModel(models, next));
          }} className="mb-5">
            <TabsList className="grid h-11 w-full grid-cols-4" aria-label="Тип генерации">
              {(["text", "image", "video", "audio"] as ModelKind[]).map((value) => {
                const Icon = KIND_ICON[value];
                return <TabsTrigger key={value} value={value} disabled={busy} className="h-9 gap-1 px-1 text-xs data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"><Icon className="size-3.5" aria-hidden="true" />{value === "image" ? "Фото" : KIND_LABEL[value]}</TabsTrigger>;
              })}
            </TabsList>
          </Tabs>
          <form onSubmit={handleSubmit} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); }
          }} className="flex flex-col gap-4">
            <fieldset disabled={busy} className="contents">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tb-model">{kind === "text" ? "Провайдер" : "Модель"}</Label>
              <ModelPicker models={taskModels} value={model} onValueChange={setModel} />
              {!taskModels.length ? <p role="status" className="text-xs text-muted-foreground">Нет моделей этого типа в каталоге.</p> : null}
              {selectedModel && !selectedModel.available ? <p role="status" className="text-xs text-muted-foreground">Сейчас нет доступного профиля. Проверьте подключение в «Профили Chrome».</p> : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between"><Label htmlFor="tb-prompt">{kind === "audio" ? "Текст озвучки" : "Промпт"}</Label><span className="text-xs tabular-nums text-muted-foreground">{prompt.length.toLocaleString("ru-RU")} симв.</span></div>
              <Textarea
                id="tb-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={kind === "audio" ? "Введите текст, который нужно озвучить…" : kind === "text" ? "Задайте вопрос или опишите задачу…" : "Опишите, что нужно создать…"}
                className="min-h-36 resize-y text-sm leading-6"
              />
            </div>

            {kind !== "text" ? <Separator /> : null}

            {kind === "image" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {aspects.length ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-aspect">Соотношение сторон</Label>
                    <Select value={aspectRatio} onValueChange={setAspectRatio}>
                      <SelectTrigger id="tb-aspect" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {aspects.map((value) => (
                          <SelectItem key={value} value={value}>
                            {ASPECT_LABELS[value] || value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                {sizes.length ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-size">Разрешение</Label>
                    <Select value={imageSize} onValueChange={setImageSize}>
                      <SelectTrigger id="tb-size" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {sizes.map((value) => (
                          <SelectItem key={value} value={value}>
                            {value.toUpperCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            ) : null}

            {kind === "video" ? (
              <>
                {videoModes.length ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-video-mode">Режим</Label>
                    <Select
                      value={videoMode}
                      onValueChange={(value) => {
                        if (isVideoMode(value)) setVideoMode(value);
                        setImageFiles([]);
                      }}
                    >
                      <SelectTrigger id="tb-video-mode" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {videoModes.map((value) => (
                          <SelectItem key={value} value={value}>
                            {VIDEO_MODE_LABELS[value]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  {aspects.length ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="tb-aspect">Соотношение сторон</Label>
                      <Select value={aspectRatio} onValueChange={setAspectRatio}>
                        <SelectTrigger id="tb-aspect" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {aspects.map((value) => (
                            <SelectItem key={value} value={value}>
                              {ASPECT_LABELS[value] || value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {durations.length ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="tb-duration">Длительность</Label>
                      <Select value={String(durationSeconds)} onValueChange={(value) => setDurationSeconds(Number(value))}>
                        <SelectTrigger id="tb-duration" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {durations.map((value) => (
                            <SelectItem key={value} value={String(value)}>
                              {value} с
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  {sizes.length ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="tb-video-resolution">Разрешение</Label>
                      <Select value={videoResolution} onValueChange={setVideoResolution}>
                        <SelectTrigger id="tb-video-resolution" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                          {sizes.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value.toUpperCase()}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
                <Alert>
                  <Info className="size-4" />
                  <AlertDescription>
                    Генерация видео может занять несколько минут — запрос останется в ожидании до готовности ролика.
                  </AlertDescription>
                </Alert>
              </>
            ) : null}

            {kind === "audio" ? (
              <div className="flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-voice-search">Поиск голоса</Label>
                    <Input
                      id="tb-voice-search"
                      value={voiceSearch}
                      onChange={(event) => setVoiceSearch(event.target.value)}
                      placeholder="Название голоса"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-preview-language">Язык примера</Label>
                    <Select value={previewLanguage} onValueChange={(value) => setPreviewLanguage(voicePreviewLanguage(value))}>
                      <SelectTrigger id="tb-preview-language" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {VOICE_PREVIEW_LANGUAGES.map((language) => (
                          <SelectItem key={language} value={language}>{voiceLanguageNames.of(language)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-voice-style">Характер звучания</Label>
                    <Select value={voiceStyle} onValueChange={setVoiceStyle}>
                      <SelectTrigger id="tb-voice-style" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Любой</SelectItem>
                        {voiceStyleOptions.map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="tb-voice-pitch">Высота голоса</Label>
                    <Select value={voicePitch} onValueChange={setVoicePitch}>
                      <SelectTrigger id="tb-voice-pitch" className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Любая</SelectItem>
                        {Object.entries(VOICE_PITCHES).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="tb-voice">Голос</Label>
                  {voiceEntries.length ? (
                    <span role="status" className="text-xs text-muted-foreground">Найдено {filteredVoices.length} из {voiceEntries.length}</span>
                  ) : null}
                </div>
                <Select value={voice} onValueChange={setVoice} disabled={!voiceEntries.length}>
                  <SelectTrigger id="tb-voice" className="w-full">
                    <SelectValue>{selectedVoicePreview?.name ?? voice}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {filteredVoices.map((entry) => (
                      <SelectItem key={entry.voiceId} value={entry.voiceId}>
                        {entry.name}
                      </SelectItem>
                    ))}
                    {!filteredVoices.length ? <p className="px-2 py-3 text-sm text-muted-foreground">Голоса не найдены</p> : null}
                  </SelectContent>
                </Select>
                {voiceCatalogError ? (
                  <p role="alert" className="text-sm text-destructive">{voiceCatalogError}</p>
                ) : selectedVoicePreview ? (
                  <>
                    <p className="text-sm text-muted-foreground">{selectedVoicePreview.description}</p>
                    <audio
                      key={`${model}:${voice}:${selectedVoicePreview.preview_language}`}
                      controls
                      preload="none"
                      src={selectedVoicePreview.preview_url}
                      aria-label={`Прослушать голос ${selectedVoicePreview.name}`}
                      className="w-full"
                      onError={() => setVoicePreviewError(true)}
                      onCanPlay={() => setVoicePreviewError(false)}
                    />
                    {voicePreviewError ? (
                      <p role="alert" className="text-sm text-destructive">Не удалось загрузить пример голоса.</p>
                    ) : null}
                  </>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">Загрузка примеров голосов…</p>
                )}
              </div>
            ) : null}

            {imageLimits.max > 0 ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tb-images">
                  {kind === "image" ? "Референсные изображения" : VIDEO_MODE_LABELS[videoMode]}
                </Label>
                <Input
                  key={`${model}-${videoMode}`}
                  id="tb-images"
                  type="file"
                  accept="image/*"
                  multiple={imageLimits.max > 1}
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []).slice(0, imageLimits.max);
                    setImageFiles(files);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Допустимо: {imageLimits.min}–{imageLimits.max}. Выбрано: {imageFiles.length}
                  {imageFiles.length ? ` (${imageFiles.map((file) => file.name).join(", ")})` : ""}
                </p>
                {kind === "image" && capabilities?.referenceImageLimits ? (
                  <p className="text-xs text-muted-foreground">
                    Рекомендации модели: объектов до {capabilities.referenceImageLimits.maxObjects}
                    {capabilities.referenceImageLimits.maxCharacters
                      ? `, персонажей до ${capabilities.referenceImageLimits.maxCharacters}`
                      : ""}
                    {capabilities.referenceImageLimits.maxStyles
                      ? `, style references до ${capabilities.referenceImageLimits.maxStyles}`
                      : ""}.
                  </p>
                ) : null}
              </div>
            ) : null}

            <Button type="submit" disabled={busy || !model || !prompt.trim()} className="mt-1 h-11 w-full gap-2">
              {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
              {busy ? `Генерация… ${formatSeconds(elapsedMs)}` : kind === "audio" ? "Озвучить" : "Сгенерировать"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">Ctrl / ⌘ + Enter</p>
            </fieldset>
          </form>
        </CardContent>
      </Card>

      <GeneratorOutput busy={busy} result={result} kind={result ? resultKind : kind} elapsedMs={elapsedMs} />
    </div>
  );
}
