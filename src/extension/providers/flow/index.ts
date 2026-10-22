import { modelSpec } from "../../../shared/contracts.js";
import { createAccountSession, requestSignal, ProviderTab } from "../../runtime/tab.js";
import {
  type ProviderTabLike,
  type ProviderAdapter,
  type ProviderContext,
  type ProviderLogger,
  type SiteModelOptions,
  NOOP_LOG,
} from "../../runtime/runtime.js";
import { BaseImageAdapter, BaseVideoAdapter } from "@tanstack/ai/adapters";
import { type ImageGenerationOptions, type VideoGenerationOptions, type VideoUrlResult } from "@tanstack/ai";
import { FlowService } from "./operations.js";
import { createFlowTransport } from "./transport.js";

// Static vendor facts: who Google Flow is, which models exist and what their
// wire-level shapes are, how to recognize its tab, and where the local
// Server bridge lives. Nothing here decides a route at execution time.

export const PROVIDER_ID = "flow";
export const FLOW_URL = "https://flow.google.com";

function urlOf(tab: Pick<chrome.tabs.Tab, "url" | "pendingUrl"> | undefined) {
  try {
    return new URL(tab?.url || tab?.pendingUrl || "");
  } catch {
    return null;
  }
}

export const TAB_CONFIG = Object.freeze({
  providerId: PROVIDER_ID,
  startUrl: FLOW_URL,
  queryUrl: "https://flow.google.com/*",
  matches(candidate: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
    const url = urlOf(candidate);
    return (
      url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname === "flow.google.com" &&
      /^\/(?:project\/[^/]+(?:\/.*)?)?$/.test(url.pathname)
    );
  },
  isSignIn(candidate: Pick<chrome.tabs.Tab, "url" | "pendingUrl">) {
    const url = urlOf(candidate);
    return url?.protocol === "https:" && url.hostname === "accounts.google.com";
  },
  signInError: "Finish Google sign-in in the Flow tab",
  notOpenError: "Google Flow did not open",
  timeoutMs: 15000,
});

export const IMAGE_ASPECTS: Readonly<Record<string, number>> = Object.freeze({
  landscape: 3,
  portrait: 2,
  square: 1,
  "four-three": 5,
  "three-four": 4,
});

export const VIDEO_ASPECTS: Readonly<Record<string, number>> = Object.freeze({
  landscape: 2,
  portrait: 1,
});

// Flow submits Omni draft clips at 360p and standard clips at 720p. Veo still
// starts at 720p; higher sizes require an explicit upsample stage.
export const VIDEO_GENERATION_RESOLUTIONS: Readonly<Record<string, number>> =
  Object.freeze({
    "360p": 4,
    "720p": 1,
  });

export const VIDEO_RESOLUTIONS: Readonly<Record<string, [number, string]>> =
  Object.freeze({
    "1080p": [2, "veo_3_1_upsampler_1080p"],
    "4k": [3, "veo_3_1_upsampler_4k"],
  });

// Omni has two materially different ways to return 720p. Keep the old
// `720p` value native for persisted projects, and expose the cheaper captured
// 360p -> 720p route as an explicit choice rather than silently changing
// quality/cost under the existing value.
export const OMNI_VIDEO_RESOLUTION_MODES: Readonly<
  Record<
    string,
    {
      generationSize: string;
      upsampleResolution?: number;
      upsampleKey?: string;
    }
  >
> = Object.freeze({
  "360p": Object.freeze({ generationSize: "360p" }),
  "720p_economy": Object.freeze({
    generationSize: "360p",
    upsampleResolution: 1,
    upsampleKey: "omni_upsampler_360p",
  }),
  "720p": Object.freeze({ generationSize: "720p" }),
  "1080p": Object.freeze({
    generationSize: "720p",
    upsampleResolution: 2,
    upsampleKey: "veo_3_1_upsampler_1080p",
  }),
});

export const VIDEO_MODE_COUNTS: Readonly<Record<string, [number, number]>> =
  Object.freeze({
    t2v: [0, 0],
    i2v: [1, 1],
    interpolation: [2, 2],
    r2v: [1, 3],
  });

const BANANA_2_1_IMAGE = requireModel("nano-banana-2.1");
const PRO_IMAGE = requireModel("gemini-3.0-pro-image");
const LITE_IMAGE = requireModel("nano-banana-2-lite");
const OMNI_VIDEO = requireModel("gemini-omni-flash-preview");
const VEO_LITE = requireModel("veo-3.1-lite-generate-preview");
const VEO_FAST = requireModel("veo-3.1-fast-generate-preview");
const VEO_QUALITY = requireModel("veo-3.1-generate-preview");
function requireModel(id: string) {
  const model = modelSpec(id);
  if (!model) throw new Error("Unknown Flow model: " + id);
  return {
    ...model,
    sizes: model.sizes ?? [],
    durations: model.durations ?? [],
  };
}
export interface FlowRoute {
  key: string;
  duration?: string;
  portrait?: string;
  keyTemplate?: string;
  lowPrioritySuffix?: string;
  durations?: readonly number[];
}
export type FlowModel =
  | {
      mediaKind: "image";
      key: string;
      sizes: readonly string[];
      maxInputs: number;
    }
  | {
      mediaKind: "video";
      family: string;
      sizes: readonly string[];
      durations: readonly number[];
      routes: Record<string, FlowRoute>;
      resolutionModes?: Readonly<
        Record<
          string,
          {
            generationSize: string;
            upsampleResolution?: number;
            upsampleKey?: string;
          }
        >
      >;
    };
export const MODELS = Object.freeze<Record<string, FlowModel>>({
  [BANANA_2_1_IMAGE.id]: {
    mediaKind: "image",
    key: "BELUGA",
    sizes: BANANA_2_1_IMAGE.sizes,
    maxInputs: BANANA_2_1_IMAGE.maxReferences,
  },
  [PRO_IMAGE.id]: {
    mediaKind: "image",
    key: "GEM_PIX_2",
    sizes: PRO_IMAGE.sizes,
    maxInputs: PRO_IMAGE.maxReferences,
  },
  // The cheap model, and the one an account with a tight allowance can
  // actually afford to run all day. It was listed as 1k-only; asked for 2k it
  // answered 2752x1536, exactly twice its 1k frame, so the limit was ours and
  // not upstream's. That matters: 1k is smaller than a 1080p canvas and has
  // to be stretched to fill one, while 2k is comfortably larger than it.
  // 4k is left off deliberately — untested here, and a faceless video has no
  // use for it.
  [LITE_IMAGE.id]: {
    mediaKind: "image",
    key: "HARBOR_SEAL",
    sizes: LITE_IMAGE.sizes,
    maxInputs: LITE_IMAGE.maxReferences,
  },
  [OMNI_VIDEO.id]: {
    mediaKind: "video",
    family: "abra",
    sizes: OMNI_VIDEO.sizes,
    resolutionModes: OMNI_VIDEO_RESOLUTION_MODES,
    durations: OMNI_VIDEO.durations,
    routes: {
      // Omni 1.1 keeps suffixless keys at 720p and appends `_360p` for its
      // lower-credit draft mode. The 2026-08-28 Flow HAR captured all four
      // text durations plus first-frame, first+last, and reference submits;
      // the official feature matrix confirms every route supports 4/6/8/10s.
      t2v: {
        key: "abra_t2v_8s",
        duration: "abra_t2v_{duration}s",
        keyTemplate: "abra_t2v_{duration}s{resolution_suffix}",
        durations: OMNI_VIDEO.durations,
      },
      i2v: {
        key: "abra_i2v_8s",
        duration: "abra_i2v_{duration}s",
        keyTemplate: "abra_i2v_{duration}s{resolution_suffix}",
        durations: OMNI_VIDEO.durations,
      },
      interpolation: {
        key: "omni_flash_i2v_8s_first_last",
        keyTemplate: "omni_flash_i2v_{duration}s_first_last{resolution_suffix}",
        durations: OMNI_VIDEO.durations,
      },
      r2v: {
        key: "abra_r2v_8s",
        keyTemplate: "abra_r2v_{duration}s{resolution_suffix}",
        durations: OMNI_VIDEO.durations,
      },
    },
  },
  [VEO_LITE.id]: {
    mediaKind: "video",
    family: "veo_3_1_lite",
    sizes: VEO_LITE.sizes,
    //: Flow removed the duration selector from every Veo 3.1 tier. Keep the
    //: observed default key instead of synthesizing obsolete short variants.
    durations: VEO_LITE.durations,
    routes: {
      t2v: {
        key: "veo_3_1_t2v_lite",
        duration: "veo_3_1_t2v_lite_{duration}s",
        lowPrioritySuffix: "_low_priority",
      },
      i2v: {
        key: "veo_3_1_i2v_lite",
        duration: "veo_3_1_i2v_s_lite_{duration}s",
        lowPrioritySuffix: "_low_priority",
      },
      interpolation: {
        key: "veo_3_1_interpolation_lite",
        duration: "veo_3_1_i2v_s_lite_{duration}s_fl",
        lowPrioritySuffix: "_low_priority",
      },
      // Captured from a successful two-reference request in the native Flow
      // UI on 2026-08-24. Lite uses its own r2v key rather than Fast's key.
      r2v: {
        key: "veo_3_1_r2v_lite",
        durations: VEO_LITE.durations,
      },
    },
  },
  [VEO_FAST.id]: {
    mediaKind: "video",
    family: "veo_3_1_fast",
    sizes: VEO_FAST.sizes,
    durations: VEO_FAST.durations,
    routes: {
      // No `ultra`. A captured session of the real Flow UI submits the bare
      // `veo_3_1_t2v_fast` at the default duration and never a `_ultra`
      // variant; the suffix came from reading a donor's bundle rather than
      // watching a request, and Flow refused every video we sent with it.
      t2v: {
        key: "veo_3_1_t2v_fast",
        portrait: "veo_3_1_t2v_fast_portrait",
        duration: "veo_3_1_t2v_fast_{duration}s",
        lowPrioritySuffix: "_relaxed",
      },
      i2v: {
        key: "veo_3_1_i2v_s_fast",
        portrait: "veo_3_1_i2v_s_fast_portrait",
        duration: "veo_3_1_i2v_s_fast_{duration}s",
        lowPrioritySuffix: "_relaxed",
      },
      interpolation: {
        key: "veo_3_1_i2v_s_fast_fl",
        portrait: "veo_3_1_i2v_s_fast_portrait_fl",
        duration: "veo_3_1_i2v_s_fast_{duration}s_fl",
        lowPrioritySuffix: "_relaxed",
      },
      r2v: {
        key: "veo_3_1_r2v_fast_landscape",
        portrait: "veo_3_1_r2v_fast_portrait",
        durations: VEO_FAST.durations,
      },
    },
  },
  [VEO_QUALITY.id]: {
    mediaKind: "video",
    family: "veo_3_1_quality",
    sizes: VEO_QUALITY.sizes,
    durations: VEO_QUALITY.durations,
    routes: {
      t2v: {
        key: "veo_3_1_t2v",
        portrait: "veo_3_1_t2v_portrait",
        duration: "veo_3_1_t2v_quality_{duration}s",
      },
      i2v: {
        key: "veo_3_1_i2v_s",
        portrait: "veo_3_1_i2v_s_portrait",
        duration: "veo_3_1_i2v_s_quality_{duration}s",
      },
      interpolation: {
        key: "veo_3_1_i2v_s_fl",
        portrait: "veo_3_1_i2v_s_portrait_fl",
        duration: "veo_3_1_i2v_s_quality_{duration}s_fl",
      },
    },
  },
});

interface FlowContext {
  email: string;
  pageError?: string;
  pageUnavailable?: boolean;
  signInRequired?: boolean;
  accountUnavailable?: boolean;
  apiReady: boolean;
}
interface FlowGlobal {
  WIZ_global_data?: { SNlM0e?: string; eptZe?: string };
}
export async function detectFlowPageContext(): Promise<FlowContext> {
  const pageText = String(document.body?.innerText || "").toLowerCase();
  const signInRequired = [
    "sign in to google flow",
    "sign in to continue to google flow",
    "войдите, чтобы продолжить работу с google flow",
    "войдите в аккаунт google, чтобы продолжить",
  ].some((marker) => pageText.includes(marker));
  const accountUnavailable = [
    "your account has been disabled",
    "this account has been disabled",
    "account suspended",
    "account is blocked",
    "flow is not available for this account",
    "flow isn't available for this account",
    "you don't have access to flow",
    "аккаунт отключен",
    "аккаунт заблокирован",
    "у вас нет доступа к flow",
    "flow недоступен для этого аккаунта",
  ].some((marker) => pageText.includes(marker));
  if (signInRequired || accountUnavailable) {
    return {
      email: "",
      pageError: "",
      signInRequired,
      accountUnavailable,
      apiReady: false,
    };
  }
  const pageError = pageText.includes(
    "application error: a client-side exception has occurred",
  )
    ? "Google Flow reported a client-side application error"
    : "";
  let email = "";
  try {
    // The RPC frontend has no NextAuth session route. Read the current Google
    // account control, never a cached identity from the retired frontend.
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    email =
      [
        ...document.querySelectorAll(
          'a[href^="https://accounts.google.com/"][aria-label]',
        ),
      ]
        .map(
          (node) =>
            String(node.getAttribute("aria-label") || "").match(
              emailPattern,
            )?.[0] || "",
        )
        .find(Boolean) || "";
  } catch {
    // Missing identity is classified by the extension runtime below.
  }

  return {
    email,
    pageError,
    signInRequired: false,
    accountUnavailable: false,
    apiReady:
      globalThis.location?.origin === "https://flow.google.com" &&
      Boolean(
        (globalThis as FlowGlobal).WIZ_global_data?.SNlM0e &&
          (globalThis as FlowGlobal).WIZ_global_data?.eptZe ===
            "/_/AiSandboxAngularFrontend/",
      ),
  };
}

export function createFlowSession(tab: ProviderTabLike) {
  async function detectAccount() {
    await tab.ensure(false);
    const account = await tab.execute(detectFlowPageContext, []);
    if (
      !account?.email ||
      !account.apiReady ||
      account.pageError ||
      account.signInRequired ||
      account.accountUnavailable
    )
      throw Object.assign(new Error("Sign in to a ready Google Flow tab"), {
        code: "PROVIDER_SIGN_IN_REQUIRED",
      });
    return { accountSubject: account.email.trim().toLowerCase() };
  }
  return createAccountSession(
    detectAccount,
    "FLOW_ACCOUNT_CHANGED",
    "Google Flow account changed",
  );
}

export interface FlowRpcDescriptor {
  id: string;
  data: unknown[];
}
/** Vendor protobuf JSON field positions, kept in their native form. */
export type FlowMedia = [
  name: string,
  projectId?: string,
  workflowId?: string,
  ...rest: unknown[],
] & {
  5?: { 8?: [status?: number, failure?: unknown[], terminal?: unknown] };
  6?: [
    [encoded?: string, seed?: number, ...rest: unknown[]] & { 13?: string },
    { 3?: string }?,
  ];
  7?: [
    [encoded?: string, seed?: number, ...rest: unknown[]] & { 8?: string },
    unknown?,
    unknown?,
    unknown?,
    { 2?: string }?,
  ];
};
export interface FlowPageResponse {
  ok: boolean;
  status: number;
  submitted: boolean;
  raw?: string;
  data?: unknown[];
  context_code?: string;
  error?: string;
  cancelled?: boolean;
}
export interface FlowPageState {
  controllers: Map<
    string,
    { controller?: AbortController; cancelled?: boolean; createdAt?: number }
  >;
  nextReqid?: number;
  rpc?: (
    rpc: FlowRpcDescriptor,
    signal?: AbortSignal,
  ) => Promise<FlowPageResponse>;
}
export type FlowRpcGlobal = typeof globalThis & {
  [key: symbol]: FlowPageState | undefined;
  WIZ_global_data?: {
    SNlM0e?: string;
    eptZe?: string;
    cfb2h?: string;
    FdrFJe?: string;
  };
};
export interface CaptchaState {
  status?: string;
  execute?: (key: string, options: { action: string }) => Promise<string>;
}
export type FlowCaptchaGlobal = typeof globalThis & {
  [key: symbol]: CaptchaState | undefined;
  WIZ_global_data?: { xZbWve?: string };
  grecaptcha?: { enterprise?: { ready?: (cb: () => void) => void } };
};

export class FlowImage extends BaseImageAdapter<string, SiteModelOptions> {
  readonly name = "flow";
  constructor(
    model: string,
    private service: FlowService,
    private context: ProviderContext,
  ) {
    super(model);
  }
  async generateImages(
    options: ImageGenerationOptions<SiteModelOptions, string>,
  ) {
    const signal = requestSignal(this.context.signal, options.abortSignal);
    options.logger.request("Flow image request", { model: this.model });
    try {
      return await this.service.generateImages(options, {
        ...this.context,
        signal,
      });
    } catch (error) {
      options.logger.errors(String(error));
      throw error;
    }
  }
}
export class FlowVideo extends BaseVideoAdapter<string, SiteModelOptions> {
  readonly name = "flow";
  private completed?: VideoUrlResult;
  constructor(
    model: string,
    private service: FlowService,
    private context: ProviderContext,
  ) {
    super({}, model);
  }
  async createVideoJob(
    options: VideoGenerationOptions<SiteModelOptions, string, number>,
  ) {
    const signal = requestSignal(this.context.signal, options.abortSignal);
    options.logger.request("Flow video request", { model: this.model });
    try {
      this.completed = await this.service.generateVideo(options, {
        ...this.context,
        signal,
      });
      return { jobId: this.context.requestId, model: this.model };
    } catch (error) {
      options.logger.errors(String(error));
      throw error;
    }
  }
  async getVideoStatus(id: string) {
    this.result(id);
    return { jobId: id, status: "completed" as const };
  }
  async getVideo(id: string) {
    return this.result(id);
  }
  private result(id: string) {
    if (id !== this.context.requestId || !this.completed)
      throw new Error("This Flow invocation has no completed video");
    return this.completed;
  }
  availableDurations() {
    return {
      kind: "discrete" as const,
      values: [...(modelSpec(this.model)?.durations || [])],
    };
  }
}
export function createFlowAdapter({
  log = NOOP_LOG,
}: { log?: ProviderLogger } = {}): ProviderAdapter {
  const tab = new ProviderTab({ ...TAB_CONFIG, log });
  const session = createFlowSession(tab),
    transport = createFlowTransport(tab);
  const service = new FlowService({
    requestRpc: transport.executeFlowRpc,
    executeCaptcha: transport.executeCaptcha,
    verifyAccount: session.verifyAccount,
  });
  return {
    id: "flow",
    tab,
    detectAccount: session.detectAccount,
    image: (model, context) => new FlowImage(model, service, context),
    video: (model, context) => new FlowVideo(model, service, context),
    fetchArtifact: (url, signal) => service.fetchArtifact(url, signal),
  };
}
