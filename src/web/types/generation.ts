import { type ModelType } from "../../shared/contracts.js";

export type ModelKind = ModelType;
export type VideoMode = "text" | "start" | "interpolation" | "reference";

export type GenerationParams = {
  aspectRatio: string;
  imageSize: string;
  videoResolution: string;
  durationSeconds: number;
  voice: string;
};

export type MediaPart = {
  text?: string;
  dataUrl?: string;
  url?: string;
  mimeType?: string;
};

export type GenerationInput = {
  model: string;
  kind: ModelKind;
  mode?: VideoMode;
  prompt: string;
  imageFiles: File[];
  generationConfig: Record<string, unknown>;
};

export type GenerationResult = {
  ok: boolean;
  httpStatus: number;
  durationMs: number;
  payload: unknown;
  rawText: string;
  parts: MediaPart[];
  responseId?: string;
  finishReason?: string;
  errorMessage?: string;
};
