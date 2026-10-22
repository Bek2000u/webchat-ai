import {
  type FlowRpcDescriptor,
  type FlowRpcGlobal,
  type FlowPageState,
  type FlowPageResponse,
  type FlowCaptchaGlobal,
  FLOW_URL,
} from "./index.js";
import { type ProviderTab, providerSessionError, sleep, getPageStateKeys } from "../../runtime/tab.js";
import { installFlowRpcTransport } from "./rpc.js";

export const FLOW_NATIVE_CAPTCHA_STATE_KEY =
  "browserCompanion.flow.nativeCaptcha.v1";
/** In-page cancellation only. No receipt caching or replay. */
export async function executeFlowPageRpc(
  stateKey: string,
  id: string,
  rpc: FlowRpcDescriptor,
): Promise<FlowPageResponse> {
  const state = (globalThis as FlowRpcGlobal)[Symbol.for(stateKey)];
  if (!state?.rpc)
    return {
      ok: false,
      status: 0,
      submitted: false,
      error: "Flow page RPC unavailable",
    };
  if (state.controllers.get(id)?.cancelled) {
    state.controllers.delete(id);
    return {
      ok: false,
      status: 0,
      submitted: false,
      cancelled: true,
      error: "Cancelled",
    };
  }
  const controller = new AbortController();
  state.controllers.set(id, { controller });
  try {
    return await state.rpc(rpc, controller.signal);
  } catch (caught) {
    return {
      ok: false,
      status: 0,
      submitted: true,
      cancelled: caught instanceof Error && caught.name === "AbortError",
      error: "Flow request outcome unknown",
      context_code: "outcome_unknown",
    };
  } finally {
    state.controllers.delete(id);
  }
}
export function createFlowTransport(tab: ProviderTab) {
  async function ensureProjectPage(projectId: string) {
    const tabId = await tab.ensure(false);
    const current = await chrome.tabs.get(tabId);
    const currentUrl = new URL(current.url || "");
    const projectUrl = new URL(
      `${FLOW_URL}/project/${encodeURIComponent(projectId)}`,
    );
    const authuser = currentUrl.searchParams.get("authuser");
    if (authuser && /^\d+$/.test(authuser))
      projectUrl.searchParams.set("authuser", authuser);
    if (!String(current?.url || "").includes(`/project/${projectId}`)) {
      await chrome.tabs.update(tabId, { url: projectUrl.href, active: false });
      await tab.ensure(false);
      await sleep(500);
    }
    return tabId;
  }

  async function executeCaptcha(
    action: string,
    projectId: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw new DOMException("Operation cancelled", "AbortError");
    await ensureProjectPage(projectId);
    const result = await tab.execute(
      async (captchaAction: string, stateName: string) => {
        const state = (globalThis as FlowCaptchaGlobal)[Symbol.for(stateName)];
        if (!state) return { ok: false, status: "missing" };
        const deadline = Date.now() + 15000;
        while (
          state.status === "waiting" &&
          typeof state.execute !== "function"
        ) {
          if (Date.now() >= deadline) return { ok: false, status: "timeout" };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (state.status !== "ready" || typeof state.execute !== "function") {
          return { ok: false, status: String(state.status || "unavailable") };
        }
        const siteKey = (globalThis as FlowCaptchaGlobal).WIZ_global_data
          ?.xZbWve;
        if (typeof siteKey !== "string" || !siteKey) {
          return { ok: false, status: "site_key_missing" };
        }
        const ready = (globalThis as FlowCaptchaGlobal).grecaptcha?.enterprise
          ?.ready;
        if (typeof ready === "function") {
          await new Promise<void>((resolve) => ready(resolve));
        }
        const token = await state.execute(siteKey, { action: captchaAction });
        return { ok: true, token: String(token || "") };
      },
      [action, FLOW_NATIVE_CAPTCHA_STATE_KEY],
    );
    if (signal?.aborted)
      throw new DOMException("Operation cancelled", "AbortError");
    if (result?.ok && result.token) return result.token;
    throw providerSessionError(
      "FLOW_NATIVE_CAPTCHA_UNAVAILABLE",
      `Google Flow native reCAPTCHA capture is unavailable (${String(result?.status || "unknown")}); reload the extension and Flow tab`,
    );
  }

  async function executeFlowRpc(
    rpc: FlowRpcDescriptor,
    signal?: AbortSignal,
  ): Promise<FlowPageResponse> {
    signal?.throwIfAborted();
    const { flowRequests } = await getPageStateKeys();
    signal?.throwIfAborted();
    await tab.execute(installFlowRpcTransport, [flowRequests]);
    const id = crypto.randomUUID();
    const abort = () => {
      const tabId = tab.tabId;
      if (typeof tabId !== "number") return;
      void chrome.scripting
        .executeScript({
          target: { tabId },
          world: "MAIN",
          func: (stateKey: string, id: string) => {
            const state = (globalThis as FlowRpcGlobal)[Symbol.for(stateKey)];
            if (!state) return;
            const current = state.controllers.get(id);
            if (current?.controller) current.controller.abort();
            else state.controllers.set(id, { cancelled: true });
          },
          args: [flowRequests, id],
        })
        .catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await tab.execute(executeFlowPageRpc, [
        flowRequests,
        id,
        rpc,
      ]);
      signal?.throwIfAborted();
      if (!result)
        throw Object.assign(new Error("Flow request outcome unknown"), {
          code: "outcome_unknown",
        });
      return result;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  return { executeCaptcha, executeFlowRpc };
}
