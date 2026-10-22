import { SERVER_COMPANION } from "../mode.js";
declare const __BUILT_SERVER_ORIGIN__: string | undefined;
export const BUILT_SERVER_ORIGIN =
  typeof __BUILT_SERVER_ORIGIN__ === "string"
    ? __BUILT_SERVER_ORIGIN__
    : SERVER_COMPANION ? "" : "http://127.0.0.1:8001";

const DEFAULT_SERVER_ORIGIN = BUILT_SERVER_ORIGIN;

export function normalizeServerOrigin(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Введите адрес Server");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Адрес Server должен быть полным URL");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error(
      "Укажите только origin Server без пути, query или credentials",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Server должен использовать HTTP или HTTPS");
  }
  const authority = raw.match(/^(?:https?):\/\/([^/?#]+)\/?$/i)?.[1] || "";
  if (!authority || authority.toLowerCase() !== parsed.host.toLowerCase()) {
    throw new Error("Server origin должен использовать каноничный host и port");
  }
  const isLoopback = ["127.0.0.1", "localhost"].includes(parsed.hostname);
  const octets = parsed.hostname.split(".").map(Number);
  const privateLan =
    octets.length === 4 &&
    octets.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) &&
    (octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  if (parsed.protocol === "http:" && !isLoopback && !privateLan) {
    throw new Error("Публичный Browser Gateway должен использовать HTTPS");
  }
  return parsed.origin;
}

export function serverPermissionOrigin(origin: string) {
  const parsed = new URL(normalizeServerOrigin(origin));
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

export { DEFAULT_SERVER_ORIGIN };
