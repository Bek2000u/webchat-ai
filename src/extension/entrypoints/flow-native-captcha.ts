import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

type CaptchaExecute = (
  siteKey: string,
  options: { action: string },
) => Promise<string>;
interface CaptchaState {
  captureVersion: number;
  status: string;
  execute: CaptchaExecute | null;
}
export default defineUnlistedScript(() => {
  const page = globalThis as typeof globalThis &
    Record<symbol, CaptchaState | undefined> & {
      grecaptcha?: { enterprise?: { execute?: CaptchaExecute } };
    };
  const STATE_KEY = "browserCompanion.flow.nativeCaptcha.v1";
  const stateKey = Symbol.for(STATE_KEY);
  const previous = page[stateKey];
  if (previous?.captureVersion === 1) return;

  const state: CaptchaState = previous || {
    captureVersion: 1,
    status: "waiting",
    execute: null,
  };
  state.captureVersion = 1;
  state.status = "waiting";
  state.execute = null;
  Object.defineProperty(globalThis, stateKey, {
    value: state,
    configurable: true,
  });

  function isEnterpriseScript(target: unknown) {
    const element = target as { tagName?: string; src?: string } | null;
    if (String(element?.tagName || "").toUpperCase() !== "SCRIPT") return false;
    try {
      const url = new URL(String(element?.src || ""), location.href);
      return (
        url.protocol === "https:" &&
        url.hostname === "www.google.com" &&
        url.pathname === "/recaptcha/enterprise.js"
      );
    } catch {
      return false;
    }
  }

  let appendTarget: Node | null = null;
  let appendDescriptor: PropertyDescriptor | null | undefined = null;
  let appendWrapper: (<T extends Node>(this: Node, child: T) => T) | null =
    null;

  function restoreAppendChild() {
    if (
      appendTarget &&
      appendDescriptor &&
      appendWrapper &&
      appendTarget.appendChild === appendWrapper
    ) {
      Object.defineProperty(appendTarget, "appendChild", appendDescriptor);
    }
    appendTarget = null;
    appendDescriptor = null;
    appendWrapper = null;
  }

  function saveExecute(enterprise: unknown, execute: unknown) {
    if (typeof execute !== "function") return false;

    // Flow replaces the public function after loading reCAPTCHA. Never save
    // that wrapper: its tokens carry an extension_hijack_detected action.
    const source = Function.prototype.toString.call(execute);
    if (source.includes("extension_hijack_detected")) {
      state.status = "patched";
      return false;
    }

    state.execute = execute.bind(enterprise) as CaptchaExecute;
    state.status = "ready";
    restoreAppendChild();
    document.removeEventListener("load", onResourceLoad, true);
    return true;
  }

  function capture() {
    const enterprise = page.grecaptcha?.enterprise;
    return saveExecute(enterprise, enterprise?.execute);
  }

  function restoredDescriptor(
    descriptor: PropertyDescriptor | undefined,
    value: unknown,
  ) {
    return {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      writable: true,
      value,
    };
  }

  function watchAssignment(
    owner: unknown,
    property: string,
    observe: (value: unknown) => unknown,
  ) {
    if (!owner || (typeof owner !== "object" && typeof owner !== "function"))
      return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, property);
    let value: unknown;
    try {
      value = (owner as Record<string, unknown>)[property];
    } catch {
      return;
    }
    if (value !== undefined && value !== null) {
      observe(value);
      return;
    }
    if (descriptor && !descriptor.configurable) return;
    Object.defineProperty(owner, property, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        return value;
      },
      set(next: unknown) {
        value = next;
        observe(next);
        Object.defineProperty(
          owner,
          property,
          restoredDescriptor(descriptor, next),
        );
      },
    });
  }

  function watchExecute(enterprise: unknown) {
    watchAssignment(enterprise, "execute", (execute: unknown) => {
      saveExecute(enterprise, execute);
    });
  }

  function watchEnterprise(grecaptcha: unknown) {
    watchAssignment(grecaptcha, "enterprise", watchExecute);
  }

  function onResourceLoad(event: Event) {
    if (isEnterpriseScript(event?.target)) capture();
  }

  // The enterprise loader creates window.grecaptcha, then .enterprise, then
  // the implementation assigns .execute. Observe those ordinary assignments
  // and immediately restore each property as a normal data property.
  watchAssignment(globalThis, "grecaptcha", watchEnterprise);

  // Flow assigns script.onload before head.appendChild. Wrap only that one
  // resource callback, capture first, then let Flow install its public guard.
  appendTarget = globalThis.Node?.prototype || null;
  appendDescriptor = appendTarget
    ? Object.getOwnPropertyDescriptor(appendTarget, "appendChild")
    : null;
  if (appendTarget && typeof appendDescriptor?.value === "function") {
    const originalAppendChild = appendDescriptor.value;
    appendWrapper = function appendChild<T extends Node>(
      this: Node,
      child: T,
    ): T {
      if (isEnterpriseScript(child)) {
        const script = child as unknown as HTMLScriptElement;
        const pageOnload = script.onload;
        script.onload = function nativeCaptchaLoaded(
          this: GlobalEventHandlers,
          event: Event,
        ) {
          capture();
          if (typeof pageOnload === "function")
            return pageOnload.call(this, event);
          return undefined;
        };
        restoreAppendChild();
      }
      return originalAppendChild.call(this, child);
    };
    Object.defineProperty(appendTarget, "appendChild", {
      ...appendDescriptor,
      value: appendWrapper,
    });
  }

  // Keep the capture listener as a harmless fallback for a browser which
  // exposes resource load during capture phase.
  document.addEventListener("load", onResourceLoad, true);
  capture();
});
