export type DesktopUpdateStatus = {
  state: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  version?: string;
  percent?: number;
  checkedAt?: string;
  reason?: "unpackaged" | "smoke";
  error?: "check" | "download";
};

/** The native updater is the only download/install owner. No release URLs cross IPC. */
export interface NativeUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class DesktopUpdates {
  private value: DesktopUpdateStatus;
  private checking?: Promise<DesktopUpdateStatus>;
  private downloading?: Promise<DesktopUpdateStatus>;

  constructor(
    private readonly updater: NativeUpdater,
    currentVersion: string,
    reason: DesktopUpdateStatus["reason"],
    private readonly publish: (status: DesktopUpdateStatus) => void,
  ) {
    this.value = { state: reason ? "disabled" : "idle", currentVersion, ...(reason ? { reason } : {}) };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on("checking-for-update", () => this.set({ state: "checking", error: undefined }));
    updater.on("update-available", (info: { version: string }) => this.set({ state: "available", version: info.version, checkedAt: new Date().toISOString(), percent: undefined, error: undefined }));
    updater.on("update-not-available", () => this.set({ state: "idle", version: undefined, checkedAt: new Date().toISOString(), percent: undefined, error: undefined }));
    updater.on("download-progress", (progress: { percent: number }) => this.set({ state: "downloading", percent: Math.max(0, Math.min(100, progress.percent)) }));
    updater.on("update-downloaded", (info: { version: string }) => this.set({ state: "downloaded", version: info.version, percent: 100, error: undefined }));
    updater.on("error", () => this.set({ state: "error", error: this.value.state === "downloading" ? "download" : "check" }));
  }

  getStatus(): DesktopUpdateStatus { return { ...this.value }; }

  check(): Promise<DesktopUpdateStatus> {
    if (["disabled", "downloading", "downloaded"].includes(this.value.state)) return Promise.resolve(this.getStatus());
    if (this.checking) return this.checking;
    this.set({ state: "checking", error: undefined });
    this.checking = this.updater.checkForUpdates()
      .then(() => this.getStatus())
      .catch(() => { this.set({ state: "error", error: "check" }); return this.getStatus(); })
      .finally(() => { this.checking = undefined; });
    return this.checking;
  }

  download(): Promise<DesktopUpdateStatus> {
    if (this.downloading) return this.downloading;
    if (this.value.state !== "available") return Promise.resolve(this.getStatus());
    this.set({ state: "downloading", percent: 0, error: undefined });
    this.downloading = this.updater.downloadUpdate()
      .then(() => this.getStatus())
      .catch(() => { this.set({ state: "error", error: "download" }); return this.getStatus(); })
      .finally(() => { this.downloading = undefined; });
    return this.downloading;
  }

  install(): void {
    if (this.value.state !== "downloaded") throw Error("Update has not been downloaded");
    this.updater.quitAndInstall(false, true);
  }

  private set(patch: Partial<DesktopUpdateStatus>): void {
    this.value = { ...this.value, ...patch };
    this.publish(this.getStatus());
  }
}
