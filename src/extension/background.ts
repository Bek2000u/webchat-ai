import { createAdapters } from "./providers/index.js";
import {
  type ProviderId,
  connectionConfigSchema,
  providerCommandSchema,
  type ExtensionSnapshot,
  type ExtensionProviderStatus,
} from "../shared/contracts.js";
import {
  BrowserRuntime,
  providerEnabled,
  setProviderEnabled,
  onMessage,
  sendMessage,
} from "./runtime/runtime.js";
import { DEV_COMPANION, SERVER_COMPANION } from "./mode.js";
import { checkCompanionUpdate, reloadCompanionWhenIdle } from "./updates.js";

export function isSettingsSender(
  sender: chrome.runtime.MessageSender,
  extensionId: string,
  settingsUrl: string,
) {
  return (
    sender.id === extensionId && sender.url?.split(/[?#]/, 1)[0] === settingsUrl
  );
}

export function startBackground() {
  const adapters = createAdapters(),
    extensionVersion = chrome.runtime.getManifest().version;
  const runtime = new BrowserRuntime(adapters, chrome.storage.local, {
    extensionVersion,
    beforeExecute: async (adapter, requestId, signal) => {
      const tabId = await adapter.tab.ensure();
      signal.throwIfAborted();
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["provider-context.js"],
        world: "ISOLATED",
      });
      const context = await sendMessage(
          "providerContext",
          { provider: adapter.id, requestId },
          { tabId, frameId: 0 },
        ),
        tab = await chrome.tabs.get(tabId);
      signal.throwIfAborted();
      if (context.url !== tab.url || !adapter.tab.matches(tab))
        throw new Error("Provider tab changed during assignment");
    },
  });
  let initialized: Promise<void>;
  function initialize() {
    return (initialized ||= (async () => {
      await chrome.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      await chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      });
      await runtime.initialize();
      if (DEV_COMPANION)
        await Promise.all(
          adapters.map((adapter) => setProviderEnabled(adapter.id, true)),
        );
    })());
  }
  function trusted(sender: chrome.runtime.MessageSender) {
    if (
      !isSettingsSender(
        sender,
        chrome.runtime.id,
        chrome.runtime.getURL("options.html"),
      )
    )
      throw new Error("Only extension settings can control profiles");
  }
  onMessage("getStatus", async ({ sender }): Promise<ExtensionSnapshot> => {
    trusted(sender);
    await initialize();
    return {
      profileId: runtime.settings.profileId,
      apiOrigin: runtime.settings.serverOrigin,
      connected: runtime.ready,
      ...(runtime.lastError ? { error: runtime.lastError } : {}),
      providers: await Promise.all(
        adapters.map(async (adapter): Promise<ExtensionProviderStatus> => {
          const info = runtime.providers.find((item) => item.id === adapter.id);
          const request = runtime.runningRequests.find(
            (item) => item.provider === adapter.id,
          );
          return {
            id: adapter.id as ProviderId,
            enabled: await providerEnabled(adapter.id),
            available: Boolean(info?.available),
            ...(request ? { activeRequestId: request.id } : {}),
            ...(info?.accountTier ? { accountTier: info.accountTier } : {}),
            ...(info?.error ? { error: info.error } : {}),
          };
        }),
      ),
    };
  });
  onMessage("configure", async ({ data, sender }) => {
    trusted(sender);
    await initialize();
    const config = connectionConfigSchema.parse(data);
    return runtime.configure(config.apiOrigin, config.serverToken);
  });
  onMessage("companionUpdate", async ({ data, sender }) => {
    trusted(sender);
    if (data.action !== "check" && data.action !== "reload") throw new Error("Unknown update action");
    await initialize();
    if (SERVER_COMPANION || DEV_COMPANION) return { available: false, busy: Boolean(runtime.runningRequests.length) };
    const update = await checkCompanionUpdate(runtime.settings.serverOrigin, extensionVersion, Boolean(runtime.runningRequests.length));
    update.busy = Boolean(runtime.runningRequests.length);
    if (data.action === "reload" && update.available)
      reloadCompanionWhenIdle(runtime.runningRequests.length, () => { runtime.disconnect(); chrome.runtime.reload(); });
    return update;
  });
  onMessage(
    "provider",
    async ({ data, sender }): Promise<{ success: true }> => {
      trusted(sender);
      const command = providerCommandSchema.parse(data);
      await initialize();
      const adapter = adapters.find((item) => item.id === command.provider);
      if (!adapter) throw new Error("Unknown provider");
      if (command.action === "open") await adapter.tab.open();
      else {
        if (
          runtime.runningRequests.some((item) => item.provider === adapter.id)
        )
          throw new Error("PROVIDER_BUSY");
        if (command.action === "setEnabled")
          await setProviderEnabled(adapter.id, command.enabled);
        await runtime.publishProviders(adapter.id);
      }
      return { success: true };
    },
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const adapter of adapters) void adapter.tab.removed(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== "complete" || !runtime.ready) return;
    const adapter = adapters.find(adapter => adapter.tab.tabId === tabId);
    if (adapter)
      void runtime.publishProviders(adapter.id).catch((error) => {
        runtime.lastError = error.message;
      });
  });
  const connect = () =>
    initialize()
      .then(() => runtime.connect())
      .catch((error) => {
        runtime.lastError = error.message;
      });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "browser-host-connect") void connect();
  });
  chrome.runtime.onStartup.addListener(() => void connect());
  chrome.runtime.onInstalled.addListener(() => void connect());
  void chrome.alarms.create("browser-host-connect", { periodInMinutes: 1 });
  void connect();
}
