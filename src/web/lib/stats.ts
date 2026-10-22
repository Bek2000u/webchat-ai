import { t, localeTag } from "../i18n.js";
import type { ModelType } from "../../shared/contracts.js";

export const operationLabels: Record<ModelType, string> = {
  text: "Текст", image: "Изображения", video: "Видео", audio: "Аудио",
};
export function statsDuration(milliseconds: number | null) {
  return milliseconds === null ? "—" : (milliseconds / 1000).toLocaleString(localeTag(), { maximumFractionDigits: 1 }) + t(" с");
}
export function statsPercent(value: number | null) {
  return value === null ? "—" : value.toLocaleString(localeTag(), { style: "percent", maximumFractionDigits: 1 });
}
