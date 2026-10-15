import {
  createAccountSession,
  isTransientTabExecutionError,
  providerSessionError,
  requestSignal,
  ProviderTab,
} from "../../runtime/tab.js";
import {
  type ProviderFailure,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderLogger,
  type SiteModelOptions,
  type ProviderMediaBody,
  NOOP_LOG,
} from "../../runtime/runtime.js";
import { prepareGoogleVidsNativeTransport, createGoogleVidsTransport, readGoogleVidsNativeState } from "./transport.js";
import { BaseAudioAdapter } from "@tanstack/ai/adapters";
import { type AudioGenerationOptions } from "@tanstack/ai";
import { modelSpec, VOICES } from "../../../shared/contracts.js";
import { joinGoogleVidsWavsBlob, readGoogleVidsWav } from "./audio.js";
import { withCrxPage } from "../../playwright/index.js";
import { prepareGoogleVidsUi } from "./ui.js";

export const PROVIDER_ID = "google_vids";
export const TTS_CHUNK_CHARS = 2500;
export const TTS_MAX_CHARS = 200000;
export const VIDS_URL = "https://docs.google.com/videos/";
export const VIDS_CREATE_URL =
  "https://docs.google.com/videos/u/0/create?usp=vids_home";

function urlOf(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl"> | undefined) {
  try {
    return new URL(tab?.url || tab?.pendingUrl || "");
  } catch {
    return null;
  }
}

export const TAB_CONFIG = Object.freeze({
  providerId: PROVIDER_ID,
  startUrl: VIDS_CREATE_URL,
  // UI automation must never adopt and overwrite an arbitrary user document.
  // The first run creates one scratch document; later browser sessions reopen
  // exactly that URL from extension-local storage.
  queryUrl: "",
  sessionTabKey: "provider.tab:google_vids.ui_v2",
  persistentUrlKey: "provider.workspace:google_vids",
  matches(candidate: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      url.hostname === "docs.google.com" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^\/videos\/d\/[^/]+(?:\/.*)?$/.test(url.pathname)
    );
  },
  isSignIn(candidate: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
    const url = urlOf(candidate);
    return url?.protocol === "https:" && url.hostname === "accounts.google.com";
  },
  signInError: "Finish Google sign-in for the Vids document",
  notOpenError: "Open an editable Google Vids document in this Chrome profile",
  timeoutMs: 20000,
});

const ACCOUNT_TIMEOUT_MS = 20000;

export async function detectGoogleVidsPageContext(
  timeoutMs = ACCOUNT_TIMEOUT_MS,
) {
  const pageStateKey = "workspaceCompanion.googleVids.transport.v1";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const findEmail = () =>
      [...document.querySelectorAll("[aria-label]")]
        .map((node) => String(node.getAttribute("aria-label") || ""))
        .map((label) => label.match(emailPattern)?.[0] || "")
        .find(Boolean) || "";
    let email = findEmail();
    let access =
      (globalThis as VidsPageGlobal)[Symbol.for(pageStateKey)]
        ?.voiceoverAccess || null;
    while ((!email || !access) && !controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      email = findEmail();
      access =
        (globalThis as VidsPageGlobal)[Symbol.for(pageStateKey)]
          ?.voiceoverAccess || null;
    }
    if (!email)
      return {
        accountSubject: "",
        voiceoverAccess: {},
        error: {
          code: "GOOGLE_VIDS_ACCOUNT_IDENTITY_PENDING",
          message: "Google Vids account identity was not detected",
        },
      };

    return {
      accountSubject: email.trim().toLowerCase(),
      voiceoverAccess: {
        access: String(access?.access || ""),
        creditsTotal: Number(access?.creditsTotal),
        creditsRemaining: Number(access?.creditsRemaining),
        checkedAt: String(access?.checkedAt || ""),
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function createGoogleVidsSession(tab: PageTab) {
  async function detectAccount() {
    try {
      // Extension reload does not inject document_start scripts into an
      // already-open document. Prepare the hook before waiting for the quota
      // metadata it captures, not only after account verification at generate.
      const tabId = await tab.ensure(false);
      if (typeof tabId !== "number") throw Error("Google Vids tab is unavailable");
      const prepareUi = async (page: import("../text.js").TextUiPage) => prepareGoogleVidsUi(page, async () => {
        const state = await tab.execute(readGoogleVidsNativeState, ["workspaceCompanion.googleVids.transport.v1"]);
        return state?.observerVersion === 5 && state.transportReady === true && state.pageExecutorReady === true && Number(state.nativeSeedCount) > 0;
      });
      await withCrxPage(tabId, AbortSignal.timeout(90000), async page => {
        await prepareUi(page);
        await prepareGoogleVidsNativeTransport(tab);
        // Hook installation may reload the editor and recreate its welcome UI.
        await prepareUi(page);
      });
      let detected = await tab.execute(detectGoogleVidsPageContext, [
        ACCOUNT_TIMEOUT_MS,
      ]);
      // A cached editor can outlive the Google session. Refresh it once before
      // any generation so ProviderTab can detect a real sign-in redirect.
      if (detected?.error?.code === "GOOGLE_VIDS_ACCOUNT_IDENTITY_PENDING") {
        await tab.ensure(true);
        await withCrxPage(tabId, AbortSignal.timeout(30000), prepareUi);
        await prepareGoogleVidsNativeTransport(tab);
        detected = await tab.execute(detectGoogleVidsPageContext, [
          ACCOUNT_TIMEOUT_MS,
        ]);
      }
      if (!detected)
        throw providerSessionError(
          "GOOGLE_VIDS_PAGE_EXECUTION_FAILED",
          "Google Vids account check returned no result",
        );
      if (detected.error)
        throw providerSessionError(detected.error.code, detected.error.message);
      const currentContext: VidsContext = {
        accountSubject: String(detected?.accountSubject || "")
          .trim()
          .toLowerCase(),
        voiceoverAccess: detected?.voiceoverAccess || {},
        accountTier: detected?.voiceoverAccess?.access === "unlimited" ? "paid"
          : detected?.voiceoverAccess?.access === "credit" ? "free" : "unknown",
      };
      if (!currentContext.accountSubject)
        throw new Error("Google Vids account identity was not detected");
      const access = String(currentContext.voiceoverAccess?.access || "");
      const planError = (code: string, message: string) => Object.assign(
        providerSessionError(code, message),
        { account: { accountSubject: currentContext.accountSubject, accountTier: currentContext.accountTier } },
      );
      if (!access) {
        throw planError(
          "GOOGLE_VIDS_PLAN_PENDING",
          "Google Vids voiceover plan was not detected",
        );
      }
      if (access === "credit") {
        throw planError(
          "GOOGLE_VIDS_PAID_PLAN_REQUIRED",
          "Google Vids voiceover requires an unlimited paid account",
        );
      }
      if (access !== "unlimited") {
        throw planError(
          "GOOGLE_VIDS_PLAN_UNKNOWN",
          "Google Vids returned an unknown account plan",
        );
      }
      return currentContext as VidsContext;
    } catch (caught) {
      const error = caught as ProviderFailure;
      if (error?.code) throw error;
      if (isTransientTabExecutionError(error)) {
        throw providerSessionError(
          "GOOGLE_VIDS_PAGE_UNAVAILABLE",
          "Google Vids document is temporarily unavailable",
        );
      }
      throw providerSessionError(
        "GOOGLE_VIDS_SESSION_FAILED",
        error.message || "Google Vids session preparation failed",
      );
    }
  }

  return createAccountSession(
    detectAccount,
    "GOOGLE_VIDS_ACCOUNT_CHANGED",
    "Google account changed after Google Vids registration",
  );
}

export interface VoiceoverAccess {
  access?: string;
  creditsTotal?: number;
  creditsRemaining?: number;
  checkedAt?: string;
}
export interface VidsContext {
  accountSubject: string;
  accountTier: "free" | "paid" | "unknown";
  voiceoverAccess: VoiceoverAccess;
}
export interface VidsNativeStatus {
  observerVersion?: number;
  marker?: string;
  transportReady?: boolean;
  pageExecutorReady?: boolean;
  nativeSeedCount?: number;
  writeAuditSeedCount?: number;
}
export interface VidsRequest {
  requestId: string;
  text: string;
  voice: string;
  language?: string;
}
export interface VidsResponse {
  ok?: boolean;
  uri?: string;
  uris?: string[];
  mimeType?: string;
  code?: string;
  message?: string;
  submitted?: boolean;
  cancelled?: boolean;
}
export interface VidsNativeSeed {
  sourcePath?: string;
}
export interface VidsPageState {
  observerVersion?: number;
  nativeXhrs?: VidsNativeSeed[];
  transport?: unknown;
  voiceoverAccess?: VoiceoverAccess;
  execute?: (requestId: string, body: string) => Promise<VidsResponse>;
  abort?: (requestId: string) => void;
  cancelled?: Set<string>;
  active?: Map<string, AbortController>;
}
export type VidsPageGlobal = typeof globalThis & {
  [key: symbol]: VidsPageState | undefined;
};
export type PartCallback = (
  part: VidsResponse,
  index: number,
) => void | Promise<void>;
export interface PageTab {
  execute<Args extends unknown[], Result>(
    func: (...args: Args) => Result,
    args: Args,
  ): Promise<Awaited<Result> | undefined>;
  ensure(force?: boolean): Promise<unknown>;
}
export interface AudioSource {
  body: ReadableStream<Uint8Array>;
  size: number;
  mimeType?: string;
}

async function fetchAudio(
  value: string,
  signal: AbortSignal,
): Promise<ProviderMediaBody> {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "contribution-qw.usercontent.google.com" ||
    url.pathname !== "/download" ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("Invalid Google Vids artifact URL");
  const response = await fetch(url, {
    signal,
    credentials: "include",
    redirect: "error",
  });
  if (!response.ok || !response.body)
    throw new Error("Google Vids audio download failed: " + response.status);
  return {
    body: response.body,
    mimeType: response.headers.get("content-type") || "audio/wav",
    size: Number(response.headers.get("content-length") || 0),
  };
}
export function createGoogleVidsAdapter({
  log = NOOP_LOG,
}: { log?: ProviderLogger } = {}): ProviderAdapter {
  const tab = new ProviderTab({ ...TAB_CONFIG, log }),
    session = createGoogleVidsSession(tab),
    transport = createGoogleVidsTransport(tab);
  const blobs = new Map<string, Blob>();
  class VidsAudio extends BaseAudioAdapter<string, SiteModelOptions> {
    readonly name = PROVIDER_ID;
    constructor(
      model: string,
      private context: ProviderContext,
    ) {
      super(model);
    }
    async generateAudio(options: AudioGenerationOptions<SiteModelOptions>) {
      const definition = modelSpec(this.model);
      if (definition?.providerId !== PROVIDER_ID)
        throw new Error("Unsupported Google Vids model");
      const modelOptions = options.modelOptions || {},
        voice = String(modelOptions.voice || definition.defaultVoice),
        language = String(modelOptions.language || "en")
          .replaceAll("_", "-")
          .split("-")[0];
      if (!VOICES.some((item) => item.id === voice))
        throw new Error("Unsupported Google Vids voice: " + voice);
      if (modelOptions.speed !== undefined && modelOptions.speed !== 1)
        throw new Error("Google Vids speech supports speed 1");
      if (!/^[a-z]{2,3}$/i.test(language))
        throw new Error("Invalid Google Vids language");
      if (options.duration !== undefined)
        throw new Error("Google Vids speech has no duration option");
      const signal = requestSignal(this.context.signal, options.abortSignal);
      signal.throwIfAborted();
      await session.verifyAccount(this.context.accountSubject);
      const wavs: Uint8Array<ArrayBuffer>[] = [];
      await transport.generate(
        {
          requestId: this.context.requestId,
          text: options.prompt,
          voice,
          language,
        },
        signal,
        async (part, index) => {
          for (let attempt = 0; ; attempt++) {
            try {
              const source = await fetchAudio(part.uri!, signal);
              wavs[index] = await readGoogleVidsWav(
                { body: source.body as ReadableStream<Uint8Array>, size: source.size || 0, mimeType: source.mimeType }, signal,
              );
              break;
            } catch (error) {
              // Retry this completed scene's original audio, never Generate all.
              if (attempt || signal.aborted) throw error;
            }
          }
        },
      );
      const blob = joinGoogleVidsWavsBlob(wavs),
        url = "webchat-ai-audio://" + this.context.requestId;
      blobs.set(url, blob);
      return {
        id: this.context.requestId,
        model: this.model,
        audio: { url, contentType: "audio/wav" },
      };
    }
  }
  return {
    id: PROVIDER_ID,
    tab,
    detectAccount: session.detectAccount,
    audio: (model, context) => new VidsAudio(model, context),
    async fetchArtifact(url, signal) {
      signal.throwIfAborted();
      const blob = blobs.get(url);
      if (!blob) throw new Error("Google Vids audio is unavailable");
      blobs.delete(url);
      return { body: blob, mimeType: blob.type, size: blob.size };
    },
    async cancel(requestId) {
      blobs.delete("webchat-ai-audio://" + requestId);
      await transport.cancel(requestId);
    },
  };
}
