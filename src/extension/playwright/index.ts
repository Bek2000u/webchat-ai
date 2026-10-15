import { source } from "../../../dist/playwright/injected-source.js";
import { CrxTransport, crxError } from "./transport.js";
import { injectedEngineKey } from "./injected.js";

export { CrxTransport } from "./transport.js";
export * from "./tabs.js";

export { version as PLAYWRIGHT_VERSION } from "../../../dist/playwright/injected-source.js";
const engineKey = injectedEngineKey;

/** Deliberately small CRX API backed by the actual upstream InjectedScript.
 * Not the full Playwright Page API. Main-document DOM only; no Node or recorder.
 */
export class CrxPage {
  private world?: Promise<number>;
  private contextId?: number;
  private worldRevision = 0;
  readonly signal: AbortSignal;
  readonly transport: CrxTransport;
  constructor(
    readonly tabId: number,
    signal: AbortSignal,
  ) {
    this.signal = signal;
    this.transport = new CrxTransport(tabId, this.signal);
    this.transport.onEvent = (method, params) => {
      if ((method === "Page.frameNavigated" && !params.frame.parentId) ||
          method === "Runtime.executionContextsCleared" ||
          (method === "Runtime.executionContextDestroyed" &&
            (this.contextId === undefined || params.executionContextId === this.contextId)))
        this.clearWorld();
    };
  }
  async attach() {
    await this.transport.attach();
    return this;
  }
  async detach() {
    await this.transport.detach();
  }
  private clearWorld() {
    this.world = undefined;
    this.contextId = undefined;
    this.worldRevision++;
  }
  private async context() {
    if (!this.world) {
      const revision = this.worldRevision;
      this.world = (async () => {
        const { frameTree } = await this.transport.send("Page.getFrameTree");
        const { executionContextId } = await this.transport.send(
          "Page.createIsolatedWorld",
          {
            frameId: frameTree.frame.id,
            worldName: "browser-companion-playwright",
            grantUniveralAccess: false,
          },
        );
        if (revision !== this.worldRevision)
          throw crxError("BROWSER_CONTEXT_LOST", "Browser document changed before context initialization");
        this.contextId = executionContextId;
        await this.evaluateRaw(source, executionContextId);
        if (revision !== this.worldRevision)
          throw crxError("BROWSER_CONTEXT_LOST", "Browser document context changed during initialization");
        return executionContextId as number;
      })();
    }
    return this.world;
  }
  private async evaluateRaw<T>(
    expression: string,
    contextId: number,
  ): Promise<T> {
    const response = await this.transport.send("Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw crxError(
        "BROWSER_SCRIPT_ERROR",
        response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text,
      );
    return response.result?.value as T;
  }
  async evaluate<Arg, Result>(
    fn: (arg: Arg) => Result,
    arg: Arg,
  ): Promise<Awaited<Result>> {
    // This public surface is for DOM reads only. Actions use evaluateInWorld
    // directly with readOnly=false so a possibly accepted Send is never replayed.
    const expression = `(${fn.toString()})(${JSON.stringify(arg) ?? "undefined"})`;
    return this.evaluateInWorld<Awaited<Result>>(expression, true);
  }
  private async evaluateInWorld<T>(expression: string, readOnly: boolean): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.signal.throwIfAborted();
      try {
        return await this.evaluateRaw<T>(expression, await this.context());
      } catch (error) {
        const code = (error as { code?: string }).code;
        const lost = code === "BROWSER_CONTEXT_LOST" || (!code &&
          /cannot find context with specified id|execution context was destroyed|cannot find execution context/i.test(String(error)));
        if (!lost) throw error;
        this.clearWorld();
        if (!readOnly)
          throw crxError("outcome_unknown", "Browser context changed during an action; the action was not replayed");
        if (attempt >= 1)
          throw crxError("BROWSER_CONTEXT_LOST", "Browser document context remained unavailable while reading the response");
      }
    }
  }
  async waitFor<T>(
    read: () => Promise<T | null | undefined | false>,
    timeoutMs = 30000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      this.signal.throwIfAborted();
      const value = await read();
      if (value) return value;
      if (Date.now() >= deadline)
        throw crxError("BROWSER_UI_TIMEOUT", "Browser UI did not become ready");
      await this.delay(100);
    }
  }
  async delay(ms: number) {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(this.signal.reason);
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      this.signal.addEventListener("abort", abort, { once: true });
    });
  }
  locator(selector: string) {
    return new CrxLocator(this, selector);
  }
  /** Ordinary navigation, never a replayable DOM read or provider API call. */
  async goto(url: string) {
    this.signal.throwIfAborted();
    const result = await this.transport.send("Page.navigate", { url });
    if (result.errorText) throw crxError("BROWSER_NAVIGATION_FAILED", "Provider page could not open");
    this.clearWorld();
  }
  getByRole(role: string, options: { name?: string | RegExp; exact?: boolean } = {}) {
    const name = options.name instanceof RegExp ? options.name.toString()
      : options.name === undefined ? undefined : JSON.stringify(options.name) + (options.exact ? "s" : "i");
    return this.locator(`internal:role=${role}${name === undefined ? "" : `[name=${name}]`}`);
  }
  getByText(text: string, exact = false) {
    return this.locator(`internal:text=${JSON.stringify(text)}${exact ? "s" : "i"}`);
  }
  async inspect(selector: string, attribute?: string) {
    return this.evaluate(({ selector, attribute, engineKey }) => {
      const engine = (globalThis as any)[Symbol.for(engineKey)];
      const node = engine.querySelectorAll(engine.parseSelector(selector), document).find((n: Element) =>
        !n.closest('[hidden], [aria-hidden="true"], [inert]') && engine.elementState(n, "visible", true).matches);
      return node ? { text: node.textContent || "", attribute: attribute ? node.getAttribute(attribute) : null } : null;
    }, { selector, attribute, engineKey });
  }
  async prepare(selector: string, action: "fill" | "click" | "press", value?: string, perform = false) {
    const fn =
      async ({ selector, action, value, engineKey, perform }: {
        selector: string; action: "fill" | "click" | "press";
        value?: string; engineKey: string; perform: boolean;
      }) => {
        const engine = (globalThis as any)[Symbol.for(engineKey)];
        const candidates: Element[] = engine.querySelectorAll(
          engine.parseSelector(selector),
          document,
        );
        const node = candidates.find(
          (node) =>
            !node.closest('[hidden], [aria-hidden="true"], [inert]') &&
            engine.elementState(node, "visible", true).matches,
        );
        if (!node) return null;
        if (action === "click")
          node.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "instant",
          });
        const states =
          action === "fill"
            ? ["visible", "enabled", "editable"]
            // A DOM click does not depend on pointer-coordinate stability.
            // RAF-based stability can wait forever in a background WebContents.
            : ["visible", "enabled"];
        if (await engine.checkElementStates(node, states, true)) return null;
        if (action === "fill") {
          if (!perform) return { result: "ready", x: 0, y: 0 };
          const result = engine.fill(node, value);
          if (result !== "needsinput") return { result, x: 0, y: 0 };
          // Execute the editing command in this document, not Input.insertText:
          // embedded Chromium can route Input.* to another WebContents even
          // when tabs.active and Page.bringToFront report the target as active.
          if (!node.isConnected || document.activeElement !== node)
            throw Error("Target editor lost focus before filling");
          if (!document.execCommand(value ? "insertText" : "delete", false, value))
            throw Error("Target document rejected the editing command");
          return { result: "done", x: 0, y: 0 };
        }
        if (action === "press") {
          if (perform) {
            (node as HTMLElement).focus();
            for (const type of ["keydown", "keyup"])
              node.dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true, composed: true }));
          }
          return { result: perform ? "done" : "ready", x: 0, y: 0 };
        }
        const box = node.getBoundingClientRect();
        const x =
          Math.max(0, box.left) +
          (Math.min(innerWidth, box.right) - Math.max(0, box.left)) / 2;
        const y =
          Math.max(0, box.top) +
          (Math.min(innerHeight, box.bottom) - Math.max(0, box.top)) / 2;
        if (
          !box.width ||
          !box.height ||
          engine.expectHitTarget({ x, y }, node) !== "done"
        )
          return null;
        if (perform) {
          if (!node.isConnected) throw Error("Target button detached before clicking");
          (node as HTMLElement).click();
        }
        return { result: perform ? "done" : "ready", x, y };
      };
    const arg = { selector, action, value, engineKey, perform };
    return this.evaluateInWorld<Awaited<ReturnType<typeof fn>>>(
      `(${fn.toString()})(${JSON.stringify(arg)})`, !perform,
    );
  }
}

export class CrxLocator {
  constructor(
    private page: CrxPage,
    readonly selector: string,
  ) {}
  async isVisible() { return Boolean(await this.page.inspect(this.selector)); }
  async getAttribute(name: string) { return (await this.page.inspect(this.selector, name))?.attribute ?? null; }
  async textContent() { return (await this.page.inspect(this.selector))?.text ?? null; }
  async press(key: string, timeoutMs = 30000) {
    await this.page.waitFor(() => this.page.prepare(this.selector, "press", key, true), timeoutMs);
  }
  async fill(value: string, timeoutMs = 30000) {
    await this.page.waitFor(
      () => this.page.prepare(this.selector, "fill", value, true),
      timeoutMs,
    );
  }
  async click(timeoutMs = 30000) {
    await this.page.waitFor(
      // Readiness and the action run atomically in one target-document call.
      // Null means no action occurred. Once performed, return done; a thrown
      // transport error exits waitFor, never replaying a possibly accepted Send.
      () => this.page.prepare(this.selector, "click", undefined, true),
      timeoutMs,
    );
  }
}

export async function withCrxPage<T>(
  tabId: number,
  signal: AbortSignal,
  run: (page: CrxPage) => Promise<T>,
): Promise<T> {
  const page = new CrxPage(tabId, signal);
  try {
    await page.attach();
    return await run(page);
  } finally {
    await page.detach();
  }
}
