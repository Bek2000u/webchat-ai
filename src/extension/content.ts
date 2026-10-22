import { onMessage } from "./runtime/runtime.js";

// Site commands remain in the existing drivers; this channel confirms the
// background's assigned top frame without sending profile credentials to it.
export function startContent() {
  const context = globalThis as typeof globalThis & {
    __browser2apiContextListener?: boolean;
  };
  if (!context.__browser2apiContextListener) {
    context.__browser2apiContextListener = true;
    onMessage("providerContext", ({ data, sender }) => {
      if (
        sender.id !== chrome.runtime.id ||
        sender.tab ||
        !sender.url?.startsWith(chrome.runtime.getURL(""))
      )
        throw new Error("Untrusted browser command sender");
      if (window !== window.top || !data.requestId)
        throw new Error("Invalid browser assignment");
      return { url: location.href };
    });
  }
}
