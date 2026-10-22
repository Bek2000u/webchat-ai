
/** Chrome tab primitives. No provider identity, model or request policy. */
export async function readTab(tabId: number | null) {
  if (!Number.isInteger(tabId)) return null;
  try { return await chrome.tabs.get(tabId!); }
  catch (error) {
    if (/no current window/i.test(String(error))) throw error;
    return null;
  }
}

export function waitForTab(tabId: number, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(updated);
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const updated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
      if (id === tabId && change.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(updated);
    void readTab(tabId).then(tab => { if (tab?.status === "complete") finish(); }, finish);
  });
}

export const queryTabs = (url: string | string[]) => chrome.tabs.query({ url });
// Embedded Chrome rejects extension-created background tabs. Open missing
// provider tabs normally; existing ready tabs are still reused without focus.
export const createTab = (url: string) => chrome.tabs.create({ url, active: true });
export const reloadTab = (tabId: number) => chrome.tabs.reload(tabId);
export const activateTab = (tabId: number) => chrome.tabs.update(tabId, { active: true });
