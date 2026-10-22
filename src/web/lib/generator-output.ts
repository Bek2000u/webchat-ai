import type { ModelEntry } from "../../shared/contracts.js";
import type { MediaPart, ModelKind } from "../types/generation.js";

export function generatorModels(models: ModelEntry[], kind: ModelKind) {
  return models.filter((model) => model.type === kind);
}

export function generatorModel(models: ModelEntry[], kind: ModelKind, current = "") {
  const choices = generatorModels(models, kind);
  return choices.find((model) => model.id === current)?.id
    ?? choices.find((model) => model.available)?.id
    ?? choices[0]?.id ?? "";
}

export function generatorMediaKind(part: MediaPart, fallback: ModelKind): ModelKind {
  if (part.text !== undefined) return "text";
  const mime = part.mimeType || /^data:([^;,]+)/i.exec(part.dataUrl ?? "")?.[1] || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return fallback;
}

export function generatorDownloadName(part: MediaPart, kind: ModelKind, index: number) {
  const mime = part.mimeType || /^data:([^;,]+)/i.exec(part.dataUrl ?? "")?.[1] || "";
  const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp"
    : mime.includes("mpeg") ? "mp3" : mime.includes("ogg") ? "ogg"
    : mime.includes("png") ? "png" : kind === "image" ? ""
    : kind === "video" ? "mp4" : kind === "audio" ? "wav" : "txt";
  return `generation-${index + 1}${extension ? `.${extension}` : ""}`;
}
