import { z } from "zod";
import {
  type AudioGenerationOptions,
  type AudioGenerationResult,
  type ImageGenerationOptions,
  type ImageGenerationResult,
  type VideoGenerationOptions,
  type VideoUrlResult,
} from "@tanstack/ai";
import { modelSpec, PROVIDERS, type ProviderId } from "./models.js";

export * from "./models.js";

export const BRIDGE_PATH = "/api/browser/socket.io";
export const UPLOAD_PATH = "/api/browser/files";
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), json);
export type ProviderOptions = JsonObject;
export const thinkingModeSchema = z.enum(["default", "fast", "deep"]);
export type ThinkingMode = z.infer<typeof thinkingModeSchema>;
export const accountTierSchema = z.enum(["free", "paid", "unknown"]);
export type AccountTier = z.infer<typeof accountTierSchema>;
export type TextProviderOptions = JsonObject & { thinking?: ThinkingMode };
export type TextDTO = {
  model: string;
  modelOptions?: TextProviderOptions;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  systemPrompts?: string[];
  outputSchema?: JsonObject;
};
export interface BrowserTextResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
export type ImageDTO = Pick<
  ImageGenerationOptions<ProviderOptions>,
  "model" | "prompt" | "size" | "numberOfImages" | "modelOptions"
>;
export type VideoDTO = Pick<
  VideoGenerationOptions<ProviderOptions>,
  "model" | "prompt" | "size" | "duration" | "modelOptions"
>;
export type AudioDTO = Pick<
  AudioGenerationOptions<ProviderOptions>,
  "model" | "prompt" | "duration" | "modelOptions"
>;
export type SDKRequest =
  | { kind: "text"; options: TextDTO }
  | { kind: "image"; options: ImageDTO }
  | { kind: "video"; options: VideoDTO }
  | { kind: "audio"; options: AudioDTO };
export type VideoResult = Omit<VideoUrlResult, "expiresAt"> & {
  expiresAt?: string;
};
export type SDKResult =
  | BrowserTextResult
  | Json
  | ImageGenerationResult
  | VideoResult
  | AudioGenerationResult;
export interface RequestError {
  code: string;
  message: string;
  provider?: ProviderId;
  stage?: string;
  outcome?: "not_submitted" | "failed" | "unknown";
  retryable?: boolean;
}
export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
  accountSubject?: string;
  accountTier?: AccountTier;
  error?: RequestError;
}
export interface BrowserIdentity {
  email?: string;
  id?: string;
}
export interface Hello {
  profileId: string;
  token: string;
  extensionVersion: string;
  providers: ProviderStatus[];
  browserIdentity?: BrowserIdentity;
}
export interface Execute {
  id: string;
  attempt?: number;
  request: SDKRequest;
}
export interface Result {
  id: string;
  attempt?: number;
  result: SDKResult;
}
export interface ErrorEvent {
  id: string;
  attempt?: number;
  error: RequestError;
}
export interface Cancel {
  id: string;
}
export interface ClientToServerEvents {
  upscale_ready: (value: { id: string; attempt: number }, acknowledge: (accepted: boolean) => void) => void;
  hello: (value: Hello) => void;
  result: (value: Result) => void;
  error: (value: ErrorEvent) => void;
}
export interface ServerToClientEvents {
  execute: (value: Execute) => void;
  cancel: (value: Cancel) => void;
}
export interface RequestRecord {
  id: string;
  request: SDKRequest;
  status: "pending" | "running" | "completed" | "error";
  profileId?: string;
  result?: SDKResult;
  error?: RequestError;
  createdAt: string;
  updatedAt: string;
  attempts: RequestAttempt[];
}
export interface RequestAttempt {
  number: number;
  model: string;
  provider: ProviderId;
  profileId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  error?: RequestError;
  decision?: "completed" | "retry" | "failed" | "unknown";
  retryAt?: string;
  upscaleReadyAt?: string;
}

const model = z.string().min(1);
const providerOptions = jsonObjectSchema.optional();
const imagePart = z
  .object({
    type: z.literal("image"),
    source: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("url"),
          value: z.string().min(1),
          mimeType: z.string().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("data"),
          value: z.string().min(1),
          mimeType: z.string().min(1),
        })
        .strict(),
    ]),
    metadata: z
      .object({
        role: z
          .enum([
            "reference",
            "mask",
            "control",
            "start_frame",
            "end_frame",
            "character",
          ])
          .optional(),
        tag: z.string().optional(),
      })
      .catchall(json)
      .optional(),
  })
  .strict();
const prompt = z.union([
  z.string(),
  z.array(
    z.union([
      z
        .object({
          type: z.literal("text"),
          content: z.string(),
          metadata: jsonObjectSchema.optional(),
        })
        .strict(),
      imagePart,
    ]),
  ),
]);
const textOptions = z
  .object({
    model,
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      )
      .min(1),
    systemPrompts: z.array(z.string()).optional(),
    modelOptions: z
      .object({ thinking: thinkingModeSchema.optional() })
      .catchall(json)
      .optional(),
    outputSchema: jsonObjectSchema.optional(),
  })
  .strict();
const imageOptions = z
  .object({
    model,
    prompt,
    size: z.string().optional(),
    numberOfImages: z.number().int().positive().optional(),
    modelOptions: providerOptions,
  })
  .strict();
const videoOptions = z
  .object({
    model,
    prompt,
    size: z.string().optional(),
    duration: z.number().finite().positive().optional(),
    modelOptions: providerOptions,
  })
  .strict();
const audioOptions = z
  .object({
    model,
    prompt: z.string(),
    duration: z.number().finite().positive().optional(),
    modelOptions: providerOptions,
  })
  .strict();
export const requestSchema: z.ZodType<SDKRequest> = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), options: textOptions }).strict(),
    z.object({ kind: z.literal("image"), options: imageOptions }).strict(),
    z.object({ kind: z.literal("video"), options: videoOptions }).strict(),
    z.object({ kind: z.literal("audio"), options: audioOptions }).strict(),
  ])
  .superRefine((request, context) => {
    const definition = modelSpec(request.options.model);
    if (!definition || definition.kind !== request.kind)
      context.addIssue({
        code: "custom",
        path: ["options", "model"],
        message: "Model does not support this request kind",
      });
  });
export const sdkErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    provider: z
      .enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]])
      .optional(),
    stage: z.string().min(1).optional(),
    outcome: z.enum(["not_submitted", "failed", "unknown"]).optional(),
    retryable: z.boolean().optional(),
  })
  .strict();
export function formatRequestError(error: RequestError): string {
  const where = [error.provider && PROVIDERS[error.provider].label, error.stage]
    .filter(Boolean)
    .join(" / ");
  return `${where ? where + " — " : ""}${error.code}: ${error.message}`;
}
export const sdkResultSchema = z.custom<SDKResult>(
  (value) => json.safeParse(value).success,
  "Result must be a serializable SDK result",
);
export const providerStatusSchema: z.ZodType<ProviderStatus> = z
  .object({
    id: z.enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]]),
    available: z.boolean(),
    accountSubject: z.string().optional(),
    accountTier: accountTierSchema.optional(),
    error: sdkErrorSchema.optional(),
  })
  .strict();
export const helloSchema: z.ZodType<Hello> = z
  .object({
    profileId: z.string().uuid(),
    token: z.string().min(1),
    extensionVersion: z.string(),
    providers: z.array(providerStatusSchema),
    browserIdentity: z.object({ email: z.string().trim().toLowerCase().max(320).optional(), id: z.string().max(256).optional() }).strict().optional(),
  })
  .strict();
export const executeSchema: z.ZodType<Execute> = z
  .object({ id: z.string().min(1), attempt: z.number().int().positive().optional(), request: requestSchema })
  .strict();
export const resultSchema: z.ZodType<Result> = z
  .object({ id: z.string().min(1), attempt: z.number().int().positive().optional(), result: sdkResultSchema })
  .strict();
export const requestErrorSchema: z.ZodType<ErrorEvent> = z
  .object({ id: z.string().min(1), attempt: z.number().int().positive().optional(), error: sdkErrorSchema })
  .strict();
export const cancelSchema: z.ZodType<Cancel> = z
  .object({ id: z.string().min(1) })
  .strict();
export const upscaleReadySchema = z.object({ id: z.string().min(1), attempt: z.number().int().positive() }).strict();
export const requestRecordSchema: z.ZodType<RequestRecord> = z
  .object({
    id: z.string().min(1),
    request: requestSchema,
    status: z.enum(["pending", "running", "completed", "error"]),
    profileId: z.string().optional(),
    result: sdkResultSchema.optional(),
    error: sdkErrorSchema.optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    attempts: z.array(z.object({
      number: z.number().int().positive(), model: z.string(),
      provider: z.enum(Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]]),
      profileId: z.string(), startedAt: z.string(), finishedAt: z.string().optional(),
      durationMs: z.number().nonnegative().optional(), error: sdkErrorSchema.optional(),
      decision: z.enum(["completed", "retry", "failed", "unknown"]).optional(),
      retryAt: z.string().optional(),
      upscaleReadyAt: z.string().optional(),
    })).default([]),
  })
  .strict();
export function parseSDKRequest(value: unknown): SDKRequest {
  return requestSchema.parse(value);
}

export type ModelType = SDKRequest["kind"];

export type ModelCapabilities = {
  provider: string;
  providerLabel: string;
  operations: string[];
  aspects: string[];
  sizes: string[];
  durations: number[];
  voices: string[];
  modes: string[];
  minImages: number;
  maxImages: number;
  modeImageCounts: Record<string, { min: number; max: number }>;
  referenceImageLimits: {
    maxObjects: number;
    maxCharacters: number;
    maxStyles: number;
  };
  defaults: Record<string, string | number | boolean>;
};

export type ModelEntry = {
  id: string;
  type: ModelType;
  displayName?: string;
  description?: string;
  available: boolean;
  availableWorkers: number;
  capabilities: ModelCapabilities;
};

export type BrokerJobStatus = "queued" | "claimed" | "succeeded" | "failed";
export type JobStatus = BrokerJobStatus;

export type JobRow = {
  id: string;
  request_id: string;
  provider_id: string;
  kind?: ModelType | "";
  model?: string;
  status: JobStatus;
  broker_status: BrokerJobStatus;
  worker_id?: string | null;
  error_code?: string | null;
  error?: string | null;
  error_details: Partial<RequestError>;
  duration_ms?: number | null;
  api_completed_at?: string | null;
  output_count: number;
  created_at: string;
  updated_at: string;
};

export type JobDetail = JobRow & {
  request: SDKRequest;
  result?: SDKResult;
  attempts: RequestAttempt[];
};

export type ProviderWorker = {
  id: string;
  account_id: string;
  provider_id: string;
  account_subject?: string;
  connection_error?: RequestError;
  online: boolean;
  enabled: boolean;
  active_jobs: number;
  queued_jobs: number;
  status: string;
  last_seen_at?: string | null;
  last_assigned_at?: string | null;
  health?: ProviderObservation;
  driver_version?: string;
  capabilities: Array<{
    operations: string[];
    model_ids: string[];
    available: boolean;
  }>;
  account_status?: {
    account_tier?: "free" | "paid" | "unknown";
    credits_remaining?: number;
    credits_total?: number;
    subscription_plan?: string;
    checked_at?: string;
  };
  connection_error_code?: string;
  connection_error_at?: string | null;
};

/** Observed execution history, not an availability promise or account block. */
export interface ProviderObservation {
  lastAssignedAt?: string;
  lastSuccess?: { model: string; at: string };
  lastError?: { model: string; at: string; error: RequestError };
}

export type Account = {
  id: string;
  label: string;
  chrome_email?: string;
  enabled: boolean;
  created_at: string;
  providers: ProviderWorker[];
};

export type ServerConfig = {
  textProviderOrder: string[];
  apiKeyConfigured: boolean;
  extensionVersion: string;
  publicApi: {
    models: string;
    chatCompletions: string;
    responses: string;
    images: string;
    speech: string;
    videos: string;
  };
};

export type DashboardStats = {
  requests: {
    total: number;
    successful: number;
    failed: number;
    by_kind: Record<
      ModelType,
      { total: number; successful: number; failed: number }
    >;
  };
  jobs: Record<BrokerJobStatus, number>;
  queue: { providers: Record<string, number>; auto: number };
  workers: { total: number; online: number };
};

export type SystemInfo = {
  total_api_keys: number;
  active_api_keys: number;
  version: string;
  node: string;
};

export type SystemInfoResponse = {
  success: boolean;
  info: SystemInfo;
};

export type ApiKeyRecord = {
  id: string;
  label: string;
  enabled: boolean;
  source: "environment" | "ui";
  mutable: boolean;
  created_at: string;
  updated_at: string;
};

export type CreatedApiKey = {
  key: ApiKeyRecord;
  secret: string;
};

export interface VideoForgeConnectorState {
  origin: string;
  tokenSaved: boolean;
  enabled: boolean;
  status: "disabled" | "connecting" | "connected" | "disconnected";
  connectionId?: string;
  error?: string;
}

export interface ApiResponses {
  models: { models: ModelEntry[] };
  accounts: Account[];
  jobs: JobRow[];
  job: JobDetail;
  stats: DashboardStats;
  config: ServerConfig;
  system: SystemInfoResponse;
  keys: ApiKeyRecord[];
  createdKey: CreatedApiKey;
}

/** Extension UI ↔ service worker DTOs. No Chrome or Node runtime dependency. */

const providerId = z.enum(
  Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]],
);
export const providerCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), provider: providerId }).strict(),
  z.object({ action: z.literal("refresh"), provider: providerId }).strict(),
  z
    .object({
      action: z.literal("setEnabled"),
      provider: providerId,
      enabled: z.boolean(),
    })
    .strict(),
]);
export type ProviderCommand = z.infer<typeof providerCommandSchema>;
export const connectionConfigSchema = z
  .object({ apiOrigin: z.string().min(1), serverToken: z.string().min(1).optional() })
  .strict();
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;
export type ConnectionResult =
  | { success: true; connected: boolean }
  | { success: false; error: string };
export interface ExtensionProviderStatus {
  id: ProviderId;
  enabled: boolean;
  available: boolean;
  activeRequestId?: string;
  accountTier?: AccountTier;
  error?: RequestError;
}
export interface ExtensionSnapshot {
  profileId: string;
  apiOrigin: string;
  connected: boolean;
  error?: string;
  providers: ExtensionProviderStatus[];
}
export interface ExtensionProtocol {
  getStatus(): ExtensionSnapshot;
  configure(data: ConnectionConfig): ConnectionResult;
  provider(data: ProviderCommand): { success: true };
  companionUpdate(data: { action: "check" | "reload" }): {
    available: boolean;
    version?: string;
    busy: boolean;
  };
  providerContext(data: { provider: string; requestId: string }): {
    url: string;
  };
}
export const uploadedFileSchema = z
  .object({
    id: z.string().min(1),
    url: z.string().url(),
    mimeType: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type UploadedFile = z.infer<typeof uploadedFileSchema>;
