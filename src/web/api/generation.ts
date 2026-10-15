import { type ModelEntry } from "../../shared/contracts.js";
import {
  type GenerationInput,
  type GenerationParams,
  type GenerationResult,
  type MediaPart,
  type ModelKind,
} from "../types/generation.js";

export function getModelKind(model: ModelEntry | undefined): ModelKind {
  return model?.type ?? "image";
}
export function buildGenerationConfig(
  kind: ModelKind,
  params: GenerationParams,
): Record<string, unknown> {
  if (kind === "image")
    return { aspectRatio: params.aspectRatio, imageSize: params.imageSize };
  if (kind === "video")
    return {
      aspectRatio: params.aspectRatio,
      resolution: params.videoResolution,
      durationSeconds: params.durationSeconds,
    };
  if (kind === "audio") return { voice: params.voice };
  return {};
}
async function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}
function parts(value: Record<string, any>): MediaPart[] {
  const text = value.choices?.[0]?.message?.content;
  if (typeof text === "string") return [{ text }];
  if (Array.isArray(value.data))
    return value.data.flatMap<MediaPart>(
      (item: { url?: string; b64_json?: string }) =>
        item.url
          ? [{ url: item.url }]
          : item.b64_json
            ? [{ dataUrl: "data:image/png;base64," + item.b64_json }]
            : [],
    );
  if (value.object === "video" && value.status === "completed")
    return [
      {
        url: `/v1/videos/${encodeURIComponent(value.id)}/content`,
        mimeType: "video/mp4",
      },
    ];
  return [];
}
export async function runGeneration(
  input: GenerationInput,
): Promise<GenerationResult> {
  const started = performance.now(),
    config = input.generationConfig;
  const imageUrls = await Promise.all(input.imageFiles.map(fileToDataUrl));
  const references = imageUrls.map((url, index) => {
    const match = /^data:([^;]+);base64,(.*)$/.exec(url)!;
    const role =
      input.mode === "interpolation"
        ? index
          ? "end_frame"
          : "start_frame"
        : input.mode === "reference"
          ? "reference"
          : "start_frame";
    return {
      type: "image",
      source: { type: "data", value: match[2], mimeType: match[1] },
      metadata: { role: input.kind === "video" ? role : "reference" },
    };
  });
  const prompt = references.length
    ? [{ type: "text", content: input.prompt }, ...references]
    : input.prompt;
  const path =
    input.kind === "text"
      ? "/v1/chat/completions"
      : input.kind === "image"
        ? "/v1/images/generations"
        : input.kind === "audio"
          ? "/v1/audio/speech"
          : "/v1/videos";
  const body =
    input.kind === "text"
      ? {
          model: input.model,
          messages: [{ role: "user", content: input.prompt }],
        }
      : input.kind === "audio"
        ? {
            model: input.model,
            input: input.prompt,
            voice: config.voice,
            response_format: "wav",
          }
        : {
            model: input.model,
            prompt,
            size: input.kind === "image" ? config.imageSize : config.resolution,
            ...(input.kind === "video"
              ? { seconds: config.durationSeconds }
              : {}),
            provider_options: {
              aspect: config.aspectRatio,
              ...(input.kind === "video" ? { mode: input.mode } : {}),
            },
          };
  let response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (response.ok && input.kind === "audio") {
    const blob = await response.blob();
    return {
      ok: true,
      httpStatus: response.status,
      durationMs: performance.now() - started,
      responseId: requestId,
      payload: { id: requestId, contentType: blob.type, bytes: blob.size },
      rawText: `[${blob.type}, ${blob.size} bytes]`,
      parts: [{ dataUrl: await fileToDataUrl(blob), mimeType: blob.type }],
    };
  }
  let rawText = await response.text();
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(rawText);
  } catch {
    payload = {};
  }
  while (
    response.ok &&
    payload.object === "video" &&
    ["queued", "in_progress"].includes(payload.status)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await fetch(`/v1/videos/${encodeURIComponent(payload.id)}`, {
      credentials: "include",
    });
    rawText = await response.text();
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = {};
    }
  }
  const error =
    typeof payload.error?.message === "string"
      ? payload.error.message
      : response.ok
        ? undefined
        : `HTTP ${response.status}`;
  return {
    ok: response.ok && !error && payload.status !== "failed",
    httpStatus: response.status,
    durationMs: performance.now() - started,
    payload,
    rawText,
    parts: parts(payload),
    responseId: payload.id ?? requestId,
    errorMessage: error,
  };
}
