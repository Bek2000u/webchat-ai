/** The desktop app updates the stable unpacked directory. Chrome only reloads it on user request. */
export interface CompanionUpdate {
  available: boolean;
  version?: string;
  busy: boolean;
}

export function newerCompanionVersion(offered: unknown, running: string): offered is string {
  if (typeof offered !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(offered)) return false;
  const candidate = offered.split(".").map(Number), current = running.split(".").map(Number);
  for (let i = 0; i < Math.max(candidate.length, current.length); i++) {
    const delta = (candidate[i] || 0) - (current[i] || 0);
    if (delta) return delta > 0;
  }
  return false;
}

export async function checkCompanionUpdate(origin: string, runningVersion: string, busy: boolean, request = fetch): Promise<CompanionUpdate> {
  const url = new URL(origin);
  // Only the local desktop app owns the installed companion directory.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return { available: false, busy };
  const response = await request(new URL("/health", url), { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!response.ok) throw new Error("COMPANION_UPDATE_CHECK_FAILED");
  const info = await response.json();
  return { available: newerCompanionVersion(info.extensionVersion, runningVersion),
    ...(typeof info.extensionVersion === "string" ? { version: info.extensionVersion } : {}), busy };
}

export function reloadCompanionWhenIdle(activeCount: number, reload: () => void) {
  if (activeCount) throw new Error("PROVIDER_BUSY");
  reload();
}
