
import { resolve } from "node:path";

/** Keep the established data directory independent of the display name. */
export function desktopDataDirectory(appData: string, configured?: string): string {
  return configured ? resolve(configured) : resolve(appData, "Chat2API");
}

/** Native shell policy. Provider sessions never enter Electron. */
export function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}
export function isAppUrl(value: string, origin: string): boolean {
  try { return new URL(value).origin === origin; } catch { return false; }
}
export function desktopPort(value: string | undefined): number {
  const port = Number(value ?? 8001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid Desktop API port");
  return port;
}
