
export {};
import type { DesktopUpdateStatus } from "../desktop/updates.js";

declare global {
  interface Window {
    webchatAI?: {
      getInfo(): Promise<{ version: string; origin: string; dataDir: string; extensionDir: string; extensionVersion: string; extensionDirectoryUpdated: boolean; language: "ru" | "uz" }>;
      openDataDirectory(): Promise<string>;
      openExtensionDirectory(): Promise<string>;
      getUpdateStatus(): Promise<DesktopUpdateStatus>;
      checkForUpdates(): Promise<DesktopUpdateStatus>;
      downloadUpdate(): Promise<DesktopUpdateStatus>;
      installUpdate(): Promise<void>;
      onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
      setLanguage(language: "ru" | "uz"): Promise<"ru" | "uz">;
    };
  }
}
