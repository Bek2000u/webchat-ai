import { contextBridge, ipcRenderer } from "electron";

// Hard cut: native shell actions only; no proxy, account tokens or generic invoke.

contextBridge.exposeInMainWorld("chat2api", {
  getInfo: () => ipcRenderer.invoke("chat2api:info"),
  openDataDirectory: () => ipcRenderer.invoke("chat2api:open-data"),
  openExtensionDirectory: () => ipcRenderer.invoke("chat2api:open-extension"),
});
