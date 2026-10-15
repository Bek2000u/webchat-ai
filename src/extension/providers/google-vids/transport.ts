import {
  type VidsNativeStatus,
  type VidsPageGlobal,
  type VidsResponse,
  type VidsRequest,
  type PageTab,
  type PartCallback,
} from "./index.js";
import { type ProviderFailure } from "../../runtime/runtime.js";
import { splitGoogleVidsScript } from "./audio.js";

const PAGE_STATE_KEY = "workspaceCompanion.googleVids.transport.v1";
const GENERATE_PATH = "/v1/genai/generate";
const WRITE_AUDIT_LOG_PATH = "/v1/genai/writeAuditLog";
const NATIVE_OBSERVER_VERSION = 5;
const READY_TIMEOUT_MS = 20000;
const INITIAL_READY_GRACE_MS = 5000;
const POLL_INTERVAL_MS = 250;

export function buildGoogleVidsRequestId(requestId: string) {
  let hash = 2166136261;
  for (const character of String(requestId || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `goog_${String(100000000 + (hash % 900000000)).padStart(9, "0")}`;
}

export function buildGoogleVidsRequestBody(
  text: string,
  voice: string,
  requestId: string,
  language = "en",
  chunkIndex = 0,
) {
  const context = Array(41).fill(null);
  context[0] = 9;
  context[4] = requestId;
  context[6] = String(chunkIndex);
  context[11] = [16, 0];
  context[13] = language;
  context[19] = 1;
  context[40] = 0;
  const voiceOptions = Array(26).fill(null);
  voiceOptions[25] = [voice];
  return JSON.stringify([
    254,
    null,
    context,
    [null, null, text],
    voiceOptions,
    null,
    1,
  ]);
}

// Runs in the Google Vids page's MAIN world and returns readiness only. The
// API key, server token, headers and native XHR objects never cross worlds.
export function readGoogleVidsNativeState(stateName: string): VidsNativeStatus {
  const state = (globalThis as VidsPageGlobal)[Symbol.for(stateName)];
  const seeds = Array.isArray(state?.nativeXhrs) ? state.nativeXhrs : [];
  const marker =
    typeof document === "undefined"
      ? ""
      : String(
          document.documentElement?.getAttribute(
            "data-workspace-companion-google-vids-driver",
          ) || "",
        );
  return {
    observerVersion: Number(state?.observerVersion || 0),
    marker,
    transportReady: Boolean(state?.transport),
    pageExecutorReady: typeof state?.execute === "function",
    nativeSeedCount: seeds.length,
    writeAuditSeedCount: seeds.filter(
      (candidate) => candidate?.sourcePath === "/v1/genai/writeAuditLog",
    ).length,
  };
}

// Runs in the Google Vids page's MAIN world. The request body crosses into the
// page, but captured credentials stay in page memory and only the final WAV URL
// is returned to the extension service worker.
export async function executeGoogleVidsPageRequest(
  stateName: string,
  requestId: string,
  body: string,
): Promise<VidsResponse> {
  const state = (globalThis as VidsPageGlobal)[Symbol.for(stateName)];
  if (typeof state?.execute !== "function") {
    return {
      ok: false,
      code: "GOOGLE_VIDS_TRANSPORT_NOT_READY",
      message: "Google Vids page executor is not ready",
      submitted: false,
    };
  }
  return await state.execute(requestId, body);
}
export function abortGoogleVidsPageRequest(
  stateName: string,
  requestId: string,
) {
  const state = (globalThis as VidsPageGlobal)[Symbol.for(stateName)];
  if (typeof state?.abort === "function") {
    state.abort(requestId);
    return;
  }
  state?.cancelled?.add(requestId);
  state?.active?.get(requestId)?.abort();
}

function driverError(result?: VidsResponse) {
  const error: ProviderFailure = new Error(
    result?.message || "Google Vids request failed",
  );
  error.code = result?.code || "GOOGLE_VIDS_ERROR";
  error.submitted = result?.submitted === true;
  return error;
}

function pause(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nativeReady(state: VidsNativeStatus) {
  return (
    state?.observerVersion === NATIVE_OBSERVER_VERSION &&
    state?.transportReady === true &&
    state?.pageExecutorReady === true &&
    Number(state?.nativeSeedCount || 0) > 0
  );
}

async function waitForNativeState(
  tab: PageTab,
  timeoutMs: number,
  pollIntervalMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let state: VidsNativeStatus = {};
  do {
    state =
      (await tab.execute(readGoogleVidsNativeState, [PAGE_STATE_KEY])) || {};
    if (nativeReady(state)) return state;
    if (Date.now() < deadline) await pause(pollIntervalMs);
  } while (Date.now() < deadline);
  return state;
}

export async function prepareGoogleVidsNativeTransport(
  tab: PageTab,
  {
    timeoutMs = READY_TIMEOUT_MS,
    initialGraceMs = INITIAL_READY_GRACE_MS,
    pollIntervalMs = POLL_INTERVAL_MS,
  } = {},
) {
  let state =
    (await tab.execute(readGoogleVidsNativeState, [PAGE_STATE_KEY])) || {};
  let reloaded = false;
  if (state.observerVersion !== NATIVE_OBSERVER_VERSION) {
    await tab.ensure(true);
    reloaded = true;
    state = await waitForNativeState(tab, timeoutMs, pollIntervalMs);
  } else if (!nativeReady(state)) {
    state = await waitForNativeState(
      tab,
      Math.min(initialGraceMs, timeoutMs),
      pollIntervalMs,
    );
  }
  if (nativeReady(state)) return state;

  if (!reloaded && state.observerVersion === NATIVE_OBSERVER_VERSION) {
    await tab.ensure(true);
    state = await waitForNativeState(tab, timeoutMs, pollIntervalMs);
  }
  if (nativeReady(state)) return state;
  if (state.observerVersion !== NATIVE_OBSERVER_VERSION) {
    throw driverError({
      code: "GOOGLE_VIDS_EXTENSION_OUTDATED",
      message: "Reload Browser Companion, then retry Google Vids",
      submitted: false,
    });
  }
  throw driverError({
    code: "GOOGLE_VIDS_TRANSPORT_NOT_READY",
    message: "Google Vids native request transport did not become ready",
    submitted: false,
  });
}

export function createGoogleVidsTransport(tab: PageTab) {
  const runningJobs = new Set<string>();
  const cancelledJobs = new Set<string>();
  const activeCalls = new Map<string, Set<string>>();

  async function cancel(requestId: string) {
    if (runningJobs.has(requestId)) cancelledJobs.add(requestId);
    const callIds = [...(activeCalls.get(requestId) || [])];
    await Promise.allSettled(
      callIds.map((callId) =>
        tab.execute(abortGoogleVidsPageRequest, [PAGE_STATE_KEY, callId]),
      ),
    );
  }

  async function run(
    { requestId, text, voice, language }: VidsRequest,
    signal?: AbortSignal,
    onPart?: PartCallback,
  ) {
    if (signal?.aborted || cancelledJobs.has(requestId)) {
      throw new DOMException("Operation cancelled", "AbortError");
    }
    const abort = () => {
      void cancel(requestId);
    };
    signal?.addEventListener("abort", abort, { once: true });
    runningJobs.add(requestId);
    let completedParts = 0;
    try {
      const chunks = splitGoogleVidsScript(text);
      const nativeRequestId = buildGoogleVidsRequestId(requestId);
      const parts: VidsResponse[] = Array(chunks.length);
      const executePart = async (index: number, checkFailed: () => boolean) => {
        const callId =
          chunks.length === 1 ? requestId : `${requestId}:${index}`;
        const body = buildGoogleVidsRequestBody(
          chunks[index],
          voice,
          nativeRequestId,
          language,
          index,
        );
        {
          if (
            signal?.aborted ||
            cancelledJobs.has(requestId) ||
            checkFailed()
          ) {
            throw new DOMException("Operation cancelled", "AbortError");
          }
          activeCalls.get(requestId)!.add(callId);
          let result;
          try {
            result = await tab.execute(executeGoogleVidsPageRequest, [
              PAGE_STATE_KEY,
              callId,
              body,
            ]);
          } finally {
            activeCalls.get(requestId)?.delete(callId);
          }
          if (
            signal?.aborted ||
            cancelledJobs.has(requestId) ||
            result?.cancelled
          ) {
            throw new DOMException("Operation cancelled", "AbortError");
          }
          if (result?.ok) {
            parts[index] = result;
            if (onPart) await onPart(result, index);
            completedParts += 1;
            return;
          }
          throw driverError(result);
        }
      };
      activeCalls.set(requestId, new Set());
      const state = await prepareGoogleVidsNativeTransport(tab);
      const width = Math.min(
        5,
        Number(state.nativeSeedCount) || 1,
        chunks.length,
      );
      let nextIndex = 0;
      let failure: unknown = null;
      const worker = async () => {
        while (nextIndex < chunks.length && !failure) {
          const index = nextIndex++;
          try {
            await executePart(index, () => Boolean(failure));
          } catch (caught) {
            const error = caught as ProviderFailure;
            if (!failure) {
              failure = error;
              const peers = [...activeCalls.get(requestId)!].filter(
                (callId) => callId !== `${requestId}:${index}`,
              );
              await Promise.allSettled(
                peers.map((callId) =>
                  tab.execute(abortGoogleVidsPageRequest, [
                    PAGE_STATE_KEY,
                    callId,
                  ]),
                ),
              );
            }
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: width }, worker));
      if (failure) throw failure;
      if (parts.length === 1) return parts[0];
      return {
        uris: parts.map((part) => part.uri),
        mimeType: "audio/wav",
        submitted: true,
      };
    } catch (caught) {
      const error = caught as ProviderFailure;
      if (completedParts && error?.name !== "AbortError") {
        error.submitted = true;
      }
      throw error;
    } finally {
      activeCalls.delete(requestId);
      runningJobs.delete(requestId);
      cancelledJobs.delete(requestId);
      signal?.removeEventListener("abort", abort);
    }
  }

  async function generate(
    request: VidsRequest,
    signal?: AbortSignal,
    onPart?: PartCallback,
  ) {
    return run(request, signal, onPart);
  }

  return { generate, cancel };
}

export {
  GENERATE_PATH,
  NATIVE_OBSERVER_VERSION,
  PAGE_STATE_KEY,
  WRITE_AUDIT_LOG_PATH,
};
