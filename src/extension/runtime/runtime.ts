import {
  type ProviderId,
  type RequestError,
  type ExtensionProtocol,
  BRIDGE_PATH,
  executeSchema,
  cancelSchema,
  modelSpec,
  type SDKRequest,
  type SDKResult,
  type Execute,
  type ProviderStatus,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type ConnectionResult,
  PROVIDERS,
  type AccountTier,
  type TextDTO,
  type BrowserTextResult,
  type BrowserIdentity,
} from "../../shared/contracts.js";
import { defineExtensionMessaging } from "@webext-core/messaging";
import { uploadResult } from "./media.js";
import { io, type Socket } from "socket.io-client";
import {
  generateImage,
  generateVideo,
  generateAudio,
  type AudioAdapter,
  type ImageAdapter,
  type VideoAdapter,
} from "@tanstack/ai";
import { normalizeServerOrigin, DEFAULT_SERVER_ORIGIN } from "./origin.js";
import { SERVER_COMPANION } from "../mode.js";
import { normalizeProviderError, textResultError } from "../../shared/errors.js";

const key = (providerId: string) => "provider.enabled:" + providerId;
export async function providerEnabled(providerId: string) {
  const value = (await chrome.storage.local.get(key(providerId)))[key(providerId)];
  return value === true || (value === undefined && providerId === "google_vids");
}
export async function setProviderEnabled(providerId: string, enabled: boolean) {
  await chrome.storage.local.set({ [key(providerId)]: enabled });
  return enabled;
}

/** One allowlisted error boundary. Never serialize stacks, tokens or raw details. */
export function toRequestError(
  caught: unknown,
  context: {
    provider: ProviderId;
    stage?: string;
    aborted?: boolean;
  },
): RequestError {
  return normalizeProviderError(caught, context);
}

export const LOG_CODES = {
  TAB_OPENED: "tab.opened",
  TAB_CLOSED: "tab.closed",
  TAB_RELOADED: "tab.reloaded",
  TAB_SIGNIN_REQUIRED: "tab.signin_required",
} as const;
export const NOOP_LOG: ProviderLogger = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  flush() {},
});

export const { sendMessage, onMessage } =
  defineExtensionMessaging<ExtensionProtocol>();

export interface ProfileStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pending = new WeakMap<ProfileStorage, Map<string, Promise<string>>>();

/** Call from background with storage.local, never storage.sync or account email. */
export function getOrCreateProfileId(
  storage: ProfileStorage,
  randomUUID: () => string = () => crypto.randomUUID(),
  key = "browser.profileId",
): Promise<string> {
  let reads = pending.get(storage);
  if (!reads) {
    reads = new Map();
    pending.set(storage, reads);
  }
  const bucket = reads;
  const previous = bucket.get(key);
  if (previous) return previous;
  const current = (async () => {
    const stored = (await storage.get(key))[key];
    // Invalid saved identity is not permission to create a second profile.
    if (stored !== undefined) {
      if (typeof stored !== "string" || !UUID_V4.test(stored)) {
        throw new Error("Stored browser profile identity is invalid");
      }
      return stored;
    }
    const id = randomUUID();
    if (!UUID_V4.test(id))
      throw new Error("Generated browser profile identity is invalid");
    await storage.set({ [key]: id });
    return id;
  })();
  bucket.set(key, current);
  void current
    .finally(() => {
      if (bucket.get(key) === current) bucket.delete(key);
    })
    .catch(() => {});
  return current;
}

export const HOST_SETTINGS_KEY = "browser.host.settings";

/** Optional profile metadata only; website accounts and connection identity stay separate. */
async function detectBrowserIdentity(): Promise<BrowserIdentity | undefined> {
  try {
    if (typeof chrome === "undefined" || !chrome.identity?.getProfileUserInfo)
      return undefined;
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    const email = typeof info?.email === "string" ? info.email.trim().toLowerCase() : "";
    const id = typeof info?.id === "string" ? info.id.trim() : "";
    return email || id ? { ...(email ? { email } : {}), ...(id ? { id } : {}) } : undefined;
  } catch {
    // Signed-out profiles and browsers without this API still connect normally.
    return undefined;
  }
}

export type BrowserSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export interface BrowserRuntimeOptions {
  extensionVersion: string;
  serverCompanion?: boolean;
  beforeExecute?(
    provider: ProviderAdapter,
    requestId: string,
    signal: AbortSignal,
  ): Promise<void>;
  socketFactory?(
    url: string,
    auth: { profileId: string; token: string; serverToken?: string },
  ): BrowserSocket;
}
interface Running {
  provider: ProviderAdapter;
  controller: AbortController;
  socket: BrowserSocket;
  operationId: string;
}
export class BrowserRuntime {
  settings!: Settings;
  socket: BrowserSocket | null = null;
  providers: ProviderStatus[] = [];
  ready = false;
  lastError = "";
  private active = new Map<string, Running>();
  private connecting: Promise<ConnectionResult> | null = null;
  private connectionVersion = 0;
  private browserIdentity?: BrowserIdentity;
  private get serverCompanion() { return this.options.serverCompanion ?? SERVER_COMPANION; }
  constructor(
    public adapters: ProviderAdapter[],
    private storage: StorageArea,
    private options: BrowserRuntimeOptions,
  ) {}
  get runningRequests() {
    return [...this.active].map(([id, item]) => ({
      id,
      provider: item.provider.id,
    }));
  }
  async initialize() {
    const profileId = await getOrCreateProfileId(this.storage),
      stored = (await this.storage.get(HOST_SETTINGS_KEY))[
        HOST_SETTINGS_KEY
      ] as Partial<Settings> | undefined;
    const serverOrigin = stored?.serverOrigin || (this.serverCompanion ? "" : DEFAULT_SERVER_ORIGIN);
    this.settings = {
      profileId,
      serverOrigin: serverOrigin ? normalizeServerOrigin(serverOrigin) : "",
      token: stored?.token || crypto.randomUUID(),
      ...(this.serverCompanion && stored?.serverToken ? { serverToken: stored.serverToken } : {}),
    };
    await this.storage.set({ [HOST_SETTINGS_KEY]: this.settings });
    this.browserIdentity = await detectBrowserIdentity();
    await Promise.all(this.adapters.map((adapter) => adapter.tab.restore()));
  }
  async configure(serverOrigin: string, serverToken?: string) {
    if (this.active.size)
      throw new Error("Wait for running requests before changing host");
    const origin = normalizeServerOrigin(serverOrigin);
    const nextServerToken = serverToken?.trim() ||
      (origin === this.settings.serverOrigin ? this.settings.serverToken : "");
    if (this.serverCompanion && !nextServerToken)
      throw new Error("SERVER_TOKEN_REQUIRED");
    this.settings = {
      ...this.settings,
      serverOrigin: origin,
      token:
        origin === this.settings.serverOrigin
          ? this.settings.token
          : crypto.randomUUID(),
      ...(this.serverCompanion ? { serverToken: nextServerToken } : {}),
    };
    await this.storage.set({ [HOST_SETTINGS_KEY]: this.settings });
    this.disconnect();
    return this.connect();
  }
  async refreshProviders(providerId?: string) {
    const updated = await Promise.all(
      this.adapters.filter(adapter => providerId === undefined || adapter.id === providerId).map(async (adapter) => {
        const definition = modelSpecForProvider(adapter.id);
        if (!(await providerEnabled(adapter.id)))
          return { id: definition, available: false };
        if (
          [...this.active.values()].some(
            (item) => item.provider.id === adapter.id,
          )
        )
          return (
            this.providers.find((item) => item.id === adapter.id) || {
              id: definition,
              available: false,
            }
          );
        try {
          const account = await adapter.detectAccount();
          return {
            id: definition,
            available: true,
            accountSubject: account.accountSubject,
            ...(account.accountTier
              ? { accountTier: account.accountTier }
              : {}),
          };
        } catch (caught) {
          const account = (caught as ProviderFailure | undefined)?.account;
          return {
            id: definition,
            available: false,
            ...(account?.accountSubject ? { accountSubject: account.accountSubject } : {}),
            ...(account?.accountTier ? { accountTier: account.accountTier } : {}),
            error: toRequestError(caught, {
              provider: definition,
              stage: "account",
            }),
          };
        }
      }),
    );
    // Merge after the await: checks for different tabs can finish independently.
    const providers = new Map(this.providers.map(provider => [provider.id, provider]));
    for (const provider of updated) providers.set(provider.id, provider);
    this.providers = [...providers.values()];
  }
  async publishProviders(providerId?: string) {
    await this.refreshProviders(providerId);
    if (this.socket?.connected) this.hello();
  }
  async connect(): Promise<ConnectionResult> {
    if (this.socket?.active || this.socket?.connected)
      return { success: true, connected: this.ready };
    if (this.connecting) return this.connecting;
    const pending = this.open(this.connectionVersion);
    this.connecting = pending;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) this.connecting = null;
    }
  }
  private async open(version: number): Promise<ConnectionResult> {
    if (!this.settings) await this.initialize();
    if (version !== this.connectionVersion)
      return { success: true, connected: false };
    try {
      if (this.serverCompanion && (!this.settings.serverOrigin || !this.settings.serverToken))
        throw new Error("SERVER_CONNECTION_REQUIRED");
      await this.refreshProviders();
      if (version !== this.connectionVersion)
        return { success: true, connected: false };
      const auth = {
        profileId: this.settings.profileId,
        token: this.settings.token,
        ...(this.serverCompanion ? { serverToken: this.settings.serverToken } : {}),
      };
      const socket =
        this.options.socketFactory?.(this.settings.serverOrigin, auth) ||
        io(this.settings.serverOrigin, {
          path: BRIDGE_PATH,
          auth,
          transports: ["websocket"],
          autoConnect: false,
        });
      this.socket = socket;
      socket.on("connect", () => {
        if (this.socket !== socket) return;
        this.ready = true;
        this.lastError = "";
        this.hello();
      });
      socket.on("execute", (value) => {
        if (this.socket !== socket) return;
        try {
          const command = executeSchema.parse(value);
          void this.execute(command, socket);
        } catch (error) {
          this.lastError = (error as Error).message;
        }
      });
      socket.on("cancel", (value) => {
        const { id } = cancelSchema.parse(value),
          running = this.active.get(id);
        if (running?.socket === socket) {
          running.controller.abort();
          void running.provider.cancel?.(running.operationId);
        }
      });
      socket.on("connect_error", (error) => {
        this.lastError = error.message;
      });
      socket.on("disconnect", () => {
        if (this.socket !== socket) return;
        this.ready = false;
        this.stopRunning();
      });
      socket.connect();
      return { success: true, connected: this.ready };
    } catch (error) {
      this.lastError = (error as Error).message;
      return { success: false, error: this.lastError };
    }
  }
  private hello() {
    this.socket?.emit("hello", {
      profileId: this.settings.profileId,
      token: this.settings.token,
      extensionVersion: this.options.extensionVersion,
      providers: this.providers,
      ...(this.browserIdentity ? { browserIdentity: this.browserIdentity } : {}),
    });
  }
  private stopRunning() {
    for (const [id, item] of this.active) {
      item.controller.abort();
      void item.provider.cancel?.(item.operationId);
    }
    this.active.clear();
  }
  disconnect() {
    this.connectionVersion++;
    this.connecting = null;
    this.stopRunning();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    socket?.disconnect();
  }
  private async execute(command: Execute, socket: BrowserSocket) {
    const definition = modelSpec(command.request.options.model),
      provider = this.adapters.find(
        (item) => item.id === definition?.providerId,
      );
    if (
      !provider ||
      !this.providers.find((item) => item.id === provider.id)?.available
    ) {
      socket.emit("error", {
        id: command.id,
        attempt: command.attempt,
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Provider is unavailable",
          outcome: "not_submitted", retryable: true,
        },
      });
      return;
    }
    if (
      [...this.active.values()].some((item) => item.provider.id === provider.id)
    ) {
      socket.emit("error", {
        id: command.id,
        attempt: command.attempt,
        error: {
          code: "PROVIDER_BUSY",
          message: "Provider already has a running request",
          outcome: "not_submitted", retryable: true,
        },
      });
      return;
    }
    const controller = new AbortController(),
      operationId = command.attempt === undefined ? command.id : `${command.id}:attempt:${command.attempt}`,
      running = { provider, controller, socket, operationId };
    this.active.set(command.id, running);
    let stage = "prepare";
    try {
      await this.options.beforeExecute?.(
        provider,
        command.id,
        controller.signal,
      );
      const context = {
        requestId: operationId,
        upscaleReady: () => new Promise<boolean>((resolve) => {
          if (controller.signal.aborted || !socket.connected) { resolve(false); return; }
          socket.timeout(5000).emit("upscale_ready", { id: command.id, attempt: command.attempt ?? 1 }, (error, accepted) => resolve(!error && accepted === true));
        }),
        accountSubject:
          this.providers.find((item) => item.id === provider.id)
            ?.accountSubject || "",
        signal: controller.signal,
      };
      stage = "execute";
      let result = await this.generate(provider, command.request, context);
      controller.signal.throwIfAborted();
      stage = "result_upload";
      result = await uploadResult(
        this.settings,
        provider,
        command.request.kind,
        result,
        { ...context, requestId: command.id },
      );
      if (
        this.active.get(command.id) !== running ||
        this.socket !== socket ||
        !socket.connected
      )
        return;
      this.active.delete(command.id);
      socket.emit("result", {
        id: command.id,
        attempt: command.attempt,
        result: JSON.parse(JSON.stringify(result)) as SDKResult,
      });
    } catch (caught) {
      if (
        this.active.get(command.id) !== running ||
        this.socket !== socket ||
        !socket.connected
      )
        return;
      this.active.delete(command.id);
      socket.emit("error", {
        id: command.id,
        attempt: command.attempt,
        error: toRequestError(caught, {
          provider: modelSpecForProvider(provider.id),
          stage,
          aborted: controller.signal.aborted,
        }),
      });
    }
  }
  private async generate(
    provider: ProviderAdapter,
    request: SDKRequest,
    context: ProviderContext,
  ): Promise<SDKResult> {
    const model = request.options.model;
    if (request.kind === "text" && provider.text) {
      const result = await provider.text(request.options, context);
      const invalid = textResultError(result, false);
      if (invalid) throw Object.assign(Error(invalid.message), invalid);
      if (request.options.outputSchema) {
        const text = result.text
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, "");
        try {
          JSON.parse(text);
        } catch {
          throw Object.assign(
            Error("Provider returned invalid structured JSON"),
            { code: "INVALID_STRUCTURED_OUTPUT", stage: "result", outcome: "failed", retryable: true },
          );
        }
        return { ...result, text };
      }
      return result;
    }
    if (request.kind === "image" && provider.image)
      return await generateImage({
        adapter: provider.image(model, context),
        ...request.options,
        abortSignal: context.signal,
      });
    if (request.kind === "audio" && provider.audio)
      return await generateAudio({
        adapter: provider.audio(model, context),
        ...request.options,
        abortSignal: context.signal,
      });
    if (request.kind === "video" && provider.video) {
      const adapter = provider.video(model, context),
        job = await generateVideo({
          adapter,
          ...request.options,
          abortSignal: context.signal,
        });
      if (!adapter.getVideo)
        throw new Error("Video adapter has no result method");
      const result = await adapter.getVideo(job.jobId);
      if (!("url" in result) || !result.url)
        throw new Error("Video adapter returned no URL");
      return JSON.parse(JSON.stringify(result)) as SDKResult;
    }
    throw new Error("Provider does not support " + request.kind);
  }
}

function modelSpecForProvider(id: string): ProviderId {
  if (!(id in PROVIDERS)) throw new Error("Unknown provider " + id);
  return id as ProviderId;
}

/// <reference types="chrome" />

export interface Settings {
  serverOrigin: string;
  serverToken?: string;
  token: string;
  profileId: string;
}
export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
export interface ProviderLogger {
  debug(
    code: string,
    detail?: Record<string, unknown>,
    requestId?: string,
  ): void;
  info(
    code: string,
    detail?: Record<string, unknown>,
    requestId?: string,
  ): void;
  warn(
    code: string,
    detail?: Record<string, unknown>,
    requestId?: string,
  ): void;
  error(
    code: string,
    detail?: Record<string, unknown>,
    requestId?: string,
  ): void;
  flush(): void;
}
export interface ProviderFailure extends Error {
  account?: Pick<ProviderStatus, "accountSubject" | "accountTier">;
  code?: string;
  status?: number;
  submitted?: boolean;
  outcome?: RequestError["outcome"];
  retryable?: boolean;
  stage?: string;
  details?: Record<string, unknown>;
}
export interface ProviderTabLike {
  readonly tabId?: number | null;
  restore(): Promise<void>;
  ensure(forceReload?: boolean): Promise<number>;
  removed(tabId: number): Promise<void>;
  open(): Promise<number>;
  matches(tab: Pick<chrome.tabs.Tab, "url">): boolean;
  execute<Args extends unknown[], Result>(
    func: (...args: Args) => Result,
    args: Args,
  ): Promise<Awaited<Result> | undefined>;
}
export type SiteModelOptions = Record<string, unknown>;
export interface ProviderContext {
  upscaleReady?: () => Promise<boolean>;
  requestId: string;
  accountSubject: string;
  signal: AbortSignal;
}
export interface ProviderMediaBody {
  body: ReadableStream<Uint8Array> | Blob | Uint8Array;
  mimeType: string;
  size?: number;
}
export interface ProviderAdapter {
  id: string;
  tab: ProviderTabLike;
  detectAccount(): Promise<{
    accountSubject: string;
    accountTier?: AccountTier;
  }>;
  text?(options: TextDTO, context: ProviderContext): Promise<BrowserTextResult>;
  image?(
    model: string,
    context: ProviderContext,
  ): ImageAdapter<string, SiteModelOptions>;
  video?(
    model: string,
    context: ProviderContext,
  ): VideoAdapter<string, SiteModelOptions>;
  audio?(
    model: string,
    context: ProviderContext,
  ): AudioAdapter<string, SiteModelOptions>;
  fetchArtifact?(url: string, signal: AbortSignal): Promise<ProviderMediaBody>;
  cancel?(requestId: string): void | Promise<unknown>;
}
