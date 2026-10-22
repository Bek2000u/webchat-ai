import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { autoUpdater } from "electron-updater";
import { desktopDataDirectory, desktopPort, isAppUrl, isExternalUrl } from "./security.js";
import { syncDesktopCompanion } from "./companion.js";
import { DesktopUpdates } from "./updates.js";
import { desktopMessages, isDesktopLanguage, readDesktopLanguage, saveDesktopLanguage, type DesktopLanguage } from "./locale.js";

// Electron shell for the local WebChat AI server.

app.setName("WebChat AI");
if (process.platform === "win32") app.setAppUserModelId("uz.sidekick.webchat-ai");
const savedDataDir = desktopDataDirectory(app.getPath("appData"), process.env.WEBCHAT_AI_DATA_DIR || process.env.CHAT2API_DATA_DIR);
mkdirSync(savedDataDir, { recursive: true });
app.setPath("userData", savedDataDir);
const lock = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined, tray: Tray | undefined, host: UtilityProcess | undefined;
let quitting = false, origin = "", hostStopped = false;
const dataDir = app.getPath("userData");
const workspace = resolve(__dirname, "../..");
const webDir = app.isPackaged ? join(process.resourcesPath, "web") : join(workspace, "dist/web");
const bundledExtensionDir = app.isPackaged ? join(process.resourcesPath, "extension") : join(workspace, "dist/extension/chrome-mv3");
const iconPath = join(app.getAppPath(), "resources/icon.png");
let language: DesktopLanguage = "ru";
let extensionDir = bundledExtensionDir;
let updates: DesktopUpdates | undefined;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

function updateTray() {
  if (!tray) return;
  const text = desktopMessages(language);
  tray.setToolTip(text.tray);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text.open, click: showWindow },
    { label: text.extension, click: () => { void shell.openPath(extensionDir); } },
    { label: text.updates, click: () => { showWindow(); void updates?.check(); } },
    { type: "separator" }, { label: text.quit, click: () => { quitting = true; app.quit(); } },
  ]));
}

function showWindow() { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function createWindow() {
  window = new BrowserWindow({
    title: "WebChat AI", width: 1280, height: 850, minWidth: 800, minHeight: 600,
    show: false, autoHideMenuBar: true, backgroundColor: "#0a0a0f", icon: iconPath,
    webPreferences: { preload: join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, ...(process.env.WEBCHAT_AI_SMOKE === "1" ? { offscreen: true } : {}) },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url, origin)) { event.preventDefault(); if (isExternalUrl(url)) void shell.openExternal(url); }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on("close", event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
  window.once("ready-to-show", () => { if (process.env.WEBCHAT_AI_SMOKE !== "1") showWindow(); });
  return window;
}

async function start() {
  language = readDesktopLanguage(dataDir, app.getLocale());
  const companion = await syncDesktopCompanion(bundledExtensionDir, dataDir);
  extensionDir = companion.extensionDir;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(desktopPort(process.env.WEBCHAT_AI_PORT)),
    DATA_DIR: dataDir, DB_PATH: join(dataDir, "app.sqlite3"), WEB_DIR: webDir,
    EXTENSION_ORIGINS: process.env.EXTENSION_ORIGINS || "chrome-extension://pnamggpmjbeoohafaokfcjhpdmijmmda",
    TEXT_PROVIDER_ORDER: process.env.TEXT_PROVIDER_ORDER,
    COMPANION_VERSION: companion.extensionVersion,
  };
  host = utilityProcess.fork(join(__dirname, "../server/index.mjs"), [], { serviceName: "WebChat AI Local API", stdio: process.env.WEBCHAT_AI_SMOKE === "1" ? "pipe" : "ignore" });
  if (process.env.WEBCHAT_AI_SMOKE === "1") host.stderr?.on("data", chunk => process.stderr.write(chunk));
  const ready = await new Promise<{ origin: string }>((done, fail) => {
    const timeout = setTimeout(() => fail(Error("Local host startup timed out")), 30000);
    host!.once("exit", () => { clearTimeout(timeout); fail(Error("Local host exited during startup")); });
    host!.on("message", message => {
      if (message.type === "ready") { clearTimeout(timeout); done(message); }
      if (message.type === "error") { clearTimeout(timeout); if (process.env.WEBCHAT_AI_SMOKE === "1") console.error(message.diagnostic); fail(Error(message.message)); }
    });
    host!.postMessage({ type: "start", env });
  });
  origin = ready.origin;
  host.on("exit", () => {
    hostStopped = true;
    if (!quitting) { void dialog.showErrorBox("WebChat AI", desktopMessages(language).stopped); quitting = true; app.quit(); }
  });
  const main = createWindow();
  updates = new DesktopUpdates(autoUpdater, app.getVersion(), process.env.WEBCHAT_AI_SMOKE === "1" ? "smoke" : !app.isPackaged ? "unpackaged" : undefined, status => {
    if (!main.isDestroyed()) main.webContents.send("webchat-ai:update-status", status);
  });
  for (const [channel, action] of [
    ["webchat-ai:info", () => ({ version: app.getVersion(), origin, dataDir, ...companion, language })],
    ["webchat-ai:open-data", () => shell.openPath(dataDir)],
    ["webchat-ai:open-extension", () => shell.openPath(extensionDir)],
    ["webchat-ai:update-status", () => updates!.getStatus()],
    ["webchat-ai:update-check", () => updates!.check()],
    ["webchat-ai:update-download", () => updates!.download()],
    ["webchat-ai:update-install", () => {
      if (updates!.getStatus().state !== "downloaded") throw Error("Update has not been downloaded");
      quitting = true;
      updates!.install();
    }],
  ] as const) ipcMain.handle(channel, event => {
    if (event.sender !== main.webContents || !isAppUrl(event.senderFrame?.url || "", origin)) throw Error("Untrusted native caller");
    return action();
  });
  ipcMain.handle("webchat-ai:language", (event, value: unknown) => {
    if (event.sender !== main.webContents || !isAppUrl(event.senderFrame?.url || "", origin)) throw Error("Untrusted native caller");
    if (!isDesktopLanguage(value)) throw Error("Unsupported language");
    saveDesktopLanguage(dataDir, value);
    language = value;
    updateTray();
    return language;
  });
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }));
  updateTray();
  tray.on("double-click", showWindow);
  await main.loadURL(`${origin}/dashboard`);
  // One metadata check per launch; downloads and installation always need a user action.
  if (updates.getStatus().state !== "disabled") {
    updateTimer = setTimeout(() => { void updates?.check(); }, 15_000);
    updateTimer.unref();
  }
}

if (!lock) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => { /* Tray owns the lifetime. */ });
  app.on("before-quit", event => {
    quitting = true;
    clearTimeout(updateTimer);
    if (host && !hostStopped) {
      event.preventDefault();
      const timer = setTimeout(() => { host?.kill(); hostStopped = true; app.quit(); }, 5000);
      host.once("exit", () => { clearTimeout(timer); hostStopped = true; tray?.destroy(); app.quit(); });
      host.postMessage({ type: "stop" });
    } else tray?.destroy();
  });
  void app.whenReady().then(start).catch(error => {
    if (process.env.WEBCHAT_AI_SMOKE !== "1") dialog.showErrorBox("WebChat AI", desktopMessages(language).startup);
    console.error("WebChat AI local host failed to start");
    if (process.env.WEBCHAT_AI_SMOKE === "1") console.error(error instanceof Error ? error.message : "Startup failed");
    quitting = true; app.quit();
  });
}
