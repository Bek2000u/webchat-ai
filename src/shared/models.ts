
/** Canonical provider/model metadata shared by host, browser and HTTP clients. */
export const PROVIDERS = {
  chatgpt_web: {
    id: "chatgpt_web",
    label: "ChatGPT Web",
  },
  gemini_web: {
    id: "gemini_web",
    label: "Gemini Web",
  },
  qwen_web: {
    id: "qwen_web",
    label: "Qwen Web",
  },
  deepseek_web: {
    id: "deepseek_web",
    label: "DeepSeek Web",
  },
  flow: {
    id: "flow",
    label: "Google Flow",
  },
  google_vids: {
    id: "google_vids",
    label: "Google Vids",
  },
} as const;
export type ProviderId = keyof typeof PROVIDERS;
export type SDKKind = "text" | "image" | "video" | "audio";
export interface ModelSpec {
  id: string;
  providerId?: ProviderId;
  label: string;
  kind: SDKKind;
  upstreamId?: string;
  timeoutMs: number;
  maxReferences: number;
  sizes?: readonly string[];
  paidSizes?: readonly string[];
  durations?: readonly number[];
  aspects?: readonly string[];
  referenceRoles?: readonly ("reference" | "start_frame" | "end_frame")[];
  nativeAudio?: boolean;
  defaultVoice?: string;
}
export const MODELS: readonly ModelSpec[] = [
  {
    id: "auto",
    label: "Auto (text)",
    kind: "text",
    timeoutMs: 600000,
    maxReferences: 0,
  },
  {
    id: "chatgpt-web",
    providerId: "chatgpt_web",
    label: "ChatGPT Web",
    kind: "text",
    timeoutMs: 600000,
    maxReferences: 0,
  },
  {
    id: "gemini-web",
    providerId: "gemini_web",
    label: "Gemini Web",
    kind: "text",
    timeoutMs: 600000,
    maxReferences: 0,
  },
  {
    id: "qwen-web",
    providerId: "qwen_web",
    label: "Qwen Web",
    kind: "text",
    timeoutMs: 600000,
    maxReferences: 0,
  },
  {
    id: "deepseek-web",
    providerId: "deepseek_web",
    label: "DeepSeek Web",
    kind: "text",
    timeoutMs: 600000,
    maxReferences: 0,
  },
  {
    id: "nano-banana-2.1",
    providerId: "flow",
    label: "Nano Banana 2.1",
    kind: "image",
    timeoutMs: 300000,
    maxReferences: 14,
    sizes: ["1k"],
    aspects: ["landscape", "portrait", "square", "four-three", "three-four"],
    referenceRoles: ["reference"],
  },
  {
    id: "gemini-3.0-pro-image",
    providerId: "flow",
    label: "Nano Banana Pro",
    kind: "image",
    timeoutMs: 300000,
    maxReferences: 14,
    sizes: ["1k", "2k", "4k"],
    aspects: ["landscape", "portrait", "square", "four-three", "three-four"],
    referenceRoles: ["reference"],
  },
  {
    id: "nano-banana-2-lite",
    providerId: "flow",
    label: "Nano Banana 2 Lite",
    kind: "image",
    timeoutMs: 300000,
    maxReferences: 14,
    sizes: ["1k", "2k"],
    aspects: ["landscape", "portrait", "square", "four-three", "three-four"],
    referenceRoles: ["reference"],
  },
  {
    id: "gemini-omni-flash-preview",
    providerId: "flow",
    label: "Omni 1.1 Flash",
    kind: "video",
    timeoutMs: 540000,
    maxReferences: 3,
    sizes: ["360p", "720p_economy", "720p", "1080p"],
    paidSizes: ["720p_economy", "1080p"],
    durations: [4, 6, 8, 10],
    nativeAudio: true,
    aspects: ["landscape", "portrait"],
    referenceRoles: ["start_frame", "end_frame", "reference"],
  },
  {
    id: "veo-3.1-lite-generate-preview",
    providerId: "flow",
    label: "Veo 3.1 Lite",
    kind: "video",
    timeoutMs: 540000,
    maxReferences: 3,
    sizes: ["720p", "1080p"],
    durations: [8],
    nativeAudio: true,
    aspects: ["landscape", "portrait"],
    referenceRoles: ["start_frame", "end_frame", "reference"],
  },
  {
    id: "veo-3.1-fast-generate-preview",
    providerId: "flow",
    label: "Veo 3.1 Fast",
    kind: "video",
    timeoutMs: 540000,
    maxReferences: 3,
    sizes: ["720p", "1080p", "4k"],
    durations: [8],
    nativeAudio: true,
    aspects: ["landscape", "portrait"],
    referenceRoles: ["start_frame", "end_frame", "reference"],
  },
  {
    id: "veo-3.1-generate-preview",
    providerId: "flow",
    label: "Veo 3.1 Quality",
    kind: "video",
    timeoutMs: 540000,
    maxReferences: 2,
    sizes: ["720p", "1080p", "4k"],
    durations: [8],
    nativeAudio: true,
    aspects: ["landscape", "portrait"],
    referenceRoles: ["start_frame", "end_frame"],
  },
  {
    id: "gemini-3.8-flash-tts",
    providerId: "google_vids",
    label: "Gemini 3.8 Flash TTS",
    kind: "audio",
    upstreamId: "gemini-3.8-flash-tts",
    timeoutMs: 21600000,
    maxReferences: 0,
    defaultVoice: "Schedar",
  },
];
// Display attributes from Google Vids' preset-voice cards.
export const VOICE_STYLES = {
  soft: "Мягкий",
  friendly: "Дружелюбный",
  calm: "Спокойный",
  gravelly: "Хриплый",
  confident: "Уверенный",
  light: "Легкий",
  ringing: "Звонкий",
  pleasant: "Приятный",
  informative: "Информативный",
  clear: "Четкий",
  excited: "Восторженный",
  mature: "Зрелый",
  firm: "Строгий",
  upbeat: "Бодрый",
  youthful: "Молодой",
  cheerful: "Веселый",
  wise: "Мудрый",
  even: "Ровный",
  warm: "Теплый",
  courteous: "Учтивый",
  bright: "Яркий",
  casual: "Неофициальный",
} as const;
export const VOICE_PITCHES = {
  high: "Высокий",
  medium: "Средний",
  "medium-low": "Средне-низкий",
  low: "Низкий",
} as const;

export const VOICES: readonly {
  id: string;
  style: keyof typeof VOICE_STYLES;
  pitch: keyof typeof VOICE_PITCHES;
}[] = [
  {
    id: "Achernar",
    style: "soft",
    pitch: "high",
  },
  {
    id: "Achird",
    style: "friendly",
    pitch: "medium-low",
  },
  {
    id: "Algieba",
    style: "calm",
    pitch: "low",
  },
  {
    id: "Algenib",
    style: "gravelly",
    pitch: "low",
  },
  {
    id: "Alnilam",
    style: "confident",
    pitch: "medium-low",
  },
  {
    id: "Aoede",
    style: "light",
    pitch: "medium",
  },
  {
    id: "Autonoe",
    style: "ringing",
    pitch: "medium",
  },
  {
    id: "Callirrhoe",
    style: "pleasant",
    pitch: "medium",
  },
  {
    id: "Charon",
    style: "informative",
    pitch: "low",
  },
  {
    id: "Despina",
    style: "calm",
    pitch: "medium",
  },
  {
    id: "Enceladus",
    style: "light",
    pitch: "low",
  },
  {
    id: "Erinome",
    style: "clear",
    pitch: "medium",
  },
  {
    id: "Fenrir",
    style: "excited",
    pitch: "medium-low",
  },
  {
    id: "Gacrux",
    style: "mature",
    pitch: "medium",
  },
  {
    id: "Iapetus",
    style: "clear",
    pitch: "medium-low",
  },
  {
    id: "Kore",
    style: "firm",
    pitch: "medium",
  },
  {
    id: "Laomedeia",
    style: "upbeat",
    pitch: "high",
  },
  {
    id: "Leda",
    style: "youthful",
    pitch: "high",
  },
  {
    id: "Orus",
    style: "confident",
    pitch: "medium-low",
  },
  {
    id: "Puck",
    style: "upbeat",
    pitch: "medium",
  },
  {
    id: "Pulcherrima",
    style: "upbeat",
    pitch: "medium",
  },
  {
    id: "Rasalgethi",
    style: "informative",
    pitch: "medium",
  },
  {
    id: "Sadachbia",
    style: "cheerful",
    pitch: "low",
  },
  {
    id: "Sadaltager",
    style: "wise",
    pitch: "medium",
  },
  {
    id: "Schedar",
    style: "even",
    pitch: "medium-low",
  },
  {
    id: "Sulafat",
    style: "warm",
    pitch: "medium",
  },
  {
    id: "Umbriel",
    style: "friendly",
    pitch: "medium-low",
  },
  {
    id: "Vindemiatrix",
    style: "courteous",
    pitch: "medium",
  },
  {
    id: "Zephyr",
    style: "bright",
    pitch: "high",
  },
  {
    id: "Zubenelgenubi",
    style: "casual",
    pitch: "medium-low",
  },
];
export type VoiceCatalogEntry = {
  voiceId: string;
  name: string;
  origin: "premade";
  style: keyof typeof VOICE_STYLES;
  style_label: string;
  pitch: keyof typeof VOICE_PITCHES;
  pitch_label: string;
  description: string;
  preview_url: string;
  preview_language: string;
};

// Google Vids editor's preset-voice samples (gemini-v4s-tts/1.1).
// These public WAV files are independent of speech generation and Google login.
export const VOICE_PREVIEW_LANGUAGES = [
  "en", "ar", "bn", "nl", "fr", "de", "hi", "id", "it", "ja", "ko", "mr",
  "pl", "pt", "ro", "ru", "es", "ta", "te", "th", "tr", "uk", "vi",
] as const;

export function voicePreviewLanguage(language = "en") {
  const requested = language.trim().replaceAll("_", "-").split("-")[0].toLowerCase();
  return VOICE_PREVIEW_LANGUAGES.find((value) => value === requested) ?? "en";
}

export function voiceCatalog(language = "en"): VoiceCatalogEntry[] {
  const previewLanguage = voicePreviewLanguage(language);
  return VOICES.map((voice) => ({
    voiceId: voice.id,
    name: voice.id,
    origin: "premade",
    style: voice.style,
    style_label: VOICE_STYLES[voice.style],
    pitch: voice.pitch,
    pitch_label: VOICE_PITCHES[voice.pitch],
    description: `${VOICE_STYLES[voice.style]}, ${VOICE_PITCHES[voice.pitch].toLowerCase()} тон`,
    preview_url: `https://ssl.gstatic.com/docs/videos/audio/voice_samples/gemini-v4s-tts/1.1/${previewLanguage}/${voice.id}.wav`,
    preview_language: previewLanguage,
  }));
}

export function modelSpec(id: string): ModelSpec | undefined {
  return MODELS.find((model) => model.id === id);
}
export const DEFAULT_TEXT_ROUTES = ["gemini-web", "chatgpt-web", "qwen-web", "deepseek-web"] as const;
export const FLOW_UPSCALE_TIMEOUT_MS = 300000;
export function providerModels(id: string): readonly ModelSpec[] {
  return MODELS.filter((model) => model.providerId === id);
}
