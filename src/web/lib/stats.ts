import type { ModelType } from "../../shared/contracts.js";

export const operationLabels: Record<ModelType, string> = {
  text: "Текст", image: "Изображения", video: "Видео", audio: "Аудио",
};
export function statsDuration(milliseconds: number | null) {
  return milliseconds === null ? "—" : (milliseconds / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " с";
}
export function statsPercent(value: number | null) {
  return value === null ? "—" : value.toLocaleString("ru-RU", { style: "percent", maximumFractionDigits: 1 });
}
