import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateStatus } from "./updates.js";

// Hard cut: native shell actions only; no proxy, account tokens or generic invoke.

contextBridge.exposeInMainWorld("webchatAI", {
  getInfo: () => ipcRenderer.invoke("webchat-ai:info"),
  openDataDirectory: () => ipcRenderer.invoke("webchat-ai:open-data"),
  openExtensionDirectory: () => ipcRenderer.invoke("webchat-ai:open-extension"),
  getUpdateStatus: () => ipcRenderer.invoke("webchat-ai:update-status"),
  checkForUpdates: () => ipcRenderer.invoke("webchat-ai:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("webchat-ai:update-download"),
  installUpdate: () => ipcRenderer.invoke("webchat-ai:update-install"),
  setLanguage: (language: "ru" | "uz") => ipcRenderer.invoke("webchat-ai:language", language),
  onUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handle = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => listener(status);
    ipcRenderer.on("webchat-ai:update-status", handle);
    return () => ipcRenderer.removeListener("webchat-ai:update-status", handle);
  },
});
