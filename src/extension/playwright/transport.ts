
// Adapted from playwright-crx CrxTransport (Apache-2.0), copyright Rui Figueira.
// Narrowed to one existing tab: no browser launch, device emulation or replay.
export function crxError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export class CrxTransport {
  private attached = false;
  private closed = false;
  private pending = new Set<(error: Error) => void>();
  onEvent?: (method: string, params: any) => void;
  constructor(
    readonly tabId: number,
    readonly signal: AbortSignal,
  ) {}

  private event = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ) => {
    if (source.tabId === this.tabId) this.onEvent?.(method, params);
  };
  private removed = (source: chrome.debugger.Debuggee) => {
    if (source.tabId !== this.tabId) return;
    this.attached = false;
    this.terminate(
      crxError(
        "outcome_unknown",
        "Chrome debugger disconnected; the request was not replayed",
      ),
    );
  };
  private abort = () => {
    this.terminate(
      this.signal.reason instanceof Error
        ? this.signal.reason
        : crxError("cancelled", "Request cancelled"),
    );
    void this.detach();
  };
  private terminate(error: Error) {
    this.closed = true;
    for (const reject of this.pending) reject(error);
    this.pending.clear();
    this.removeListeners();
  }
  private removeListeners() {
    chrome.debugger?.onEvent.removeListener(this.event);
    chrome.debugger?.onDetach.removeListener(this.removed);
    this.signal.removeEventListener("abort", this.abort);
  }
  async attach() {
    this.signal.throwIfAborted();
    if (!chrome.debugger)
      throw crxError(
        "BROWSER_DEBUGGER_UNAVAILABLE",
        "This browser does not expose chrome.debugger; enable the debugger permission and reload the extension",
      );
    chrome.debugger.onEvent.addListener(this.event);
    chrome.debugger.onDetach.addListener(this.removed);
    this.signal.addEventListener("abort", this.abort, { once: true });
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, "1.3");
      this.attached = true;
      this.signal.throwIfAborted();
      if (this.closed)
        throw crxError(
          "outcome_unknown",
          "Chrome debugger disconnected during attachment",
        );
      await this.send("Page.enable");
      await this.send("Runtime.enable");
      // Match upstream Chromium Playwright initialization. Native sites may
      // defer bootstrap/rendering until visible/focused even after a DOM Send.
      // Keep the real foreground tab untouched; this override ends on detach.
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (error) {
      await this.detach();
      throw error;
    }
  }
  async send<T = any>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    if (this.closed || !this.attached)
      throw crxError(
        "outcome_unknown",
        "Chrome debugger is disconnected; the request was not replayed",
      );
    return await new Promise<T>((resolve, reject) => {
      this.pending.add(reject);
      chrome.debugger.sendCommand({ tabId: this.tabId }, method, params).then(
        (result) => {
          this.pending.delete(reject);
          resolve(result as T);
        },
        (error) => {
          this.pending.delete(reject);
          if (
            /not attached|detached|target closed|no tab with id/i.test(String(error))
          ) {
            const disconnected = crxError(
              "outcome_unknown",
              "Chrome debugger disconnected; the request was not replayed",
            );
            this.attached = false;
            this.terminate(disconnected);
            reject(disconnected);
          } else reject(error);
        },
      );
    });
  }
  async detach() {
    this.terminate(crxError("outcome_unknown", "Chrome debugger detached"));
    if (!this.attached) return;
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => {});
  }
}
