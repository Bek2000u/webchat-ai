import { contextBridge, ipcRenderer } from "electron";

// Hard cut: native shell actions only; no proxy, account tokens or generic invoke.

contextBridge.exposeInMainWorld("webchatAI", {
  getInfo: () => ipcRenderer.invoke("webchat-ai:info"),
  openDataDirectory: () => ipcRenderer.invoke("webchat-ai:open-data"),
  openExtensionDirectory: () => ipcRenderer.invoke("webchat-ai:open-extension"),
});
