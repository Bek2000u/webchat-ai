import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  MODELS,
  modelSpec,
  UPLOAD_PATH,
  type RequestRecord,
  type ProviderId,
  type ProviderWorker,
  type JobRow,
  type DashboardStats,
  type ApiResponses,
  type UploadedFile,
  PROVIDERS,
  VOICES,
  type ModelSpec,
  type ModelEntry,
} from "../shared/contracts.js";
import { KeyStore, Auth, requireLocalUI, requireServerUI } from "./auth.js";
import { fileResponse, FileStore } from "./files.js";
import { ApiStore } from "./storage.js";
import { BrowserDispatcher } from "./runtime.js";
import { ServiceError, apiError } from "./errors.js";
import { createTextEndpoints } from "./text.js";
import { mountMedia } from "./media.js";
import { saveSettings, settingsSchema } from "./settings.js";
import { operationStats, statsQuerySchema, STATS_RECORD_LIMIT } from "./stats.js";
import { type VideoForgeConnector } from "./videoforge-connector.js";

export interface ApiConfig {
  dataDir: string;
  webDir: string;
  bootstrapApiKey: string;
  fileSecret: string;
  version: string;
  internalApiKey?: string;
  mode: "desktop" | "server";
  serverToken?: string;
  extensionVersion?: string;
  publicOrigin?: string;
}
export function createApp({
  store,
  host,
  files,
  config: overrides,
  connector,
}: {
  store: ApiStore;
  host: BrowserDispatcher;
  files: FileStore;
  config: Partial<ApiConfig>;
  connector?: VideoForgeConnector;
}) {
  const config: ApiConfig = {
    dataDir: resolve("data"),
    webDir: resolve("dist/web"),
    bootstrapApiKey: "",
    fileSecret: randomBytes(32).toString("base64url"),
    version: "0.2.0",
    mode: "desktop",
    ...overrides,
  };
  if (config.mode === "server" && !config.serverToken?.trim())
    throw Error("SERVER_TOKEN is required in server mode");
  const app = new Hono(),
    keys = new KeyStore(store.db, config.bootstrapApiKey),
    auth = new Auth(keys, config.fileSecret, config.internalApiKey, config.mode === "server" ? config.serverToken : "");
  const requireUI = config.mode === "server"
    ? (c: Parameters<typeof requireLocalUI>[0]) => requireServerUI(c, config.serverToken!)
    : requireLocalUI;
  function workers(): ProviderWorker[] {
    const connected = host.connectedIds(),
      requests = store.listRequests(100000);
    return store.listProfiles().flatMap((profile) =>
      profile.providers.map((provider) => {
        const active = requests.filter(
          (request) =>
            request.profileId === profile.id &&
            (request.attempts.at(-1)?.provider ?? modelSpec(request.request.options.model)?.providerId) ===
              provider.id &&
            request.status === "running",
        ).length;
        const enabled =
            profile.enabled && !profile.disabledProviders.includes(provider.id),
          online = connected.has(profile.id);
        return {
          id: `${profile.id}:${provider.id}`,
          account_id: profile.id,
          provider_id: provider.id,
          account_subject: provider.accountSubject,
          online,
          enabled,
          active_jobs: active,
          queued_jobs: requests.filter(
            (request) =>
              request.status === "pending" &&
              modelSpec(request.request.options.model)?.providerId ===
                provider.id,
          ).length,
          status: !enabled
            ? "disabled"
            : !online
              ? "offline"
              : !provider.available
                ? "error"
                : active
                  ? "busy"
                  : "ready",
          last_seen_at: online ? profile.updatedAt : null,
          last_assigned_at: host.health(profile.id, provider.id).lastAssignedAt ?? null,
          health: host.health(profile.id, provider.id),
          driver_version: profile.extensionVersion,
          capabilities: [
            {
              operations: [
                ...new Set(
                  MODELS.filter(
                    (model) => model.providerId === provider.id,
                  ).map((model) => model.kind),
                ),
              ],
              model_ids: MODELS.filter(
                (model) => model.providerId === provider.id,
              ).map((model) => model.id),
              available: provider.available,
            },
          ],
          account_status: {
            account_tier: provider.accountTier ?? "unknown",
            ...(provider.accountTier && provider.accountTier !== "unknown"
              ? {
                  subscription_plan:
                    provider.accountTier === "paid" ? "Paid" : "Free",
                }
              : {}),
          },
          connection_error_code: provider.error?.code ?? "",
          connection_error: provider.error,
          connection_error_at: null,
        };
      }),
    );
  }
  const find = (id: string) => {
    const record = store.getRequest(id);
    if (!record)
      throw new ServiceError("Request not found", 404, "request_not_found");
    return record;
  };
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob: https://ssl.gstatic.com; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    if (/^\/(api|v1)\//.test(c.req.path)) c.header("Cache-Control", "no-store");
    await next();
    if (c.req.path.startsWith("/v1/")) {
      if (!c.res.headers.has("x-request-id"))
        c.header("x-request-id", randomUUID());
      c.header("x-should-retry", "false");
    }
  });
  app.onError((error, c) => {
    const exc = apiError(error);
    if (error instanceof ServiceError && error.details)
      c.header("x-request-id", error.details.request_id);
    return c.json(
      c.req.path.startsWith("/v1/")
        ? exc.body
        : { detail: exc.body.error.message },
      exc.status as 400,
    );
  });
  for (const path of ["/health", "/health/live"]) app.get(path, (c) =>
    c.json({ status: "ok", service: "webchat-ai", version: config.version,
      ...(config.extensionVersion ? { extensionVersion: config.extensionVersion } : {}),
    }),
  );
  app.get("/health/ready", (c) => {
    const check =
      Object.values(
        store.db
          .prepare("PRAGMA quick_check(1)")
          .get() ?? {},
      )[0] ?? "error";
    return c.json(
      {
        status: check === "ok" ? "ok" : "error",
        service: "webchat-ai",
        version: config.version,
        database: check,
      },
      check === "ok" ? 200 : 503,
    );
  });
  app.use("/v1/*", async (c, next) => {
    if (!c.req.path.startsWith("/v1/files/")) auth.requireApi(c);
    await next();
  });
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 140 * 1024 * 1024,
      onError: () => {
        throw new ServiceError(
          "Request body is too large",
          413,
          "request_too_large",
        );
      },
    }),
  );
  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: MODELS.map((model) => publicModel(model, workers(), host.modelsFor(model.id))),
    }),
  );
  app.get("/v1/models/:id", (c) => {
    const model = modelSpec(c.req.param("id"));
    if (!model)
      throw new ServiceError("Model not found", 404, "model_not_found");
    return c.json(publicModel(model, workers(), host.modelsFor(model.id)));
  });
  const text = createTextEndpoints(host);
  app.post("/v1/chat/completions", (c) => text.chat.handler(c.req.raw));
  app.post("/v1/responses", (c) => text.responses.handler(c.req.raw));
  mountMedia(app, host, files);
  app.get("/v1/files/:id", async (c) => {
    const id = c.req.param("id");
    if (!auth.verifyFile(id, c.req.query("token") ?? ""))
      throw new ServiceError("Invalid file token", 403, "invalid_file_token");
    const file = files.get(id);
    if (!file) throw new ServiceError("File not found", 404, "file_not_found");
    return fileResponse(file.path, file.mimeType, c.req.header("range"));
  });
  app.post(UPLOAD_PATH, async (c) => {
    const profileId = c.req.header("x-profile-id") ?? "",
      id = c.req.header("x-request-id") ?? "",
      token = (
        /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""
      ).trim();
    const authorize = () => host.authorizeFile(profileId, token, id);
    if (!authorize())
      throw new ServiceError("Active request credentials required", 403);
    const request = find(id),
      mime = (c.req.header("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
    if (
      request.request.kind === "text" ||
      !mime.startsWith(request.request.kind + "/")
    )
      throw new ServiceError("Media type does not match request", 422);
    const file = await files.put(c.req.raw.body, id, mime, authorize);
    const url = `${config.publicOrigin || new URL(c.req.url).origin}/v1/files/${file.id}?token=${auth.signFile(file.id)}`;
    return c.json(
      {
        id: file.id,
        url,
        mimeType: file.mimeType,
        bytes: file.bytes,
        sha256: file.sha256,
      } satisfies UploadedFile,
      201,
    );
  });
  app.use("/api/*", async (c, next) => {
    // Binary uploads are authenticated against the active Chrome request.
    if (c.req.path !== UPLOAD_PATH) requireUI(c);
    await next();
  });
  app.get("/api/models", (c) =>
    c.json({ models: MODELS.map((model) => uiModel(model, workers(), host.modelsFor(model.id))) }),
  );
  app.get("/api/accounts", (c) =>
    c.json(
      store.listProfiles().map((profile) => ({
        id: profile.id,
        label: profile.label,
        chrome_email: profile.browserIdentity?.email,
        enabled: profile.enabled,
        created_at: profile.createdAt,
        providers: workers().filter(
          (worker) => worker.account_id === profile.id,
        ),
      })),
    ),
  );
  app.patch("/api/provider-workers/:id", async (c) => {
    const value = z.object({ enabled: z.boolean() }).parse(await c.req.json()),
      id = c.req.param("id"),
      index = id.lastIndexOf(":"),
      profile = store.getProfile(id.slice(0, index)),
      provider = id.slice(index + 1);
    if (
      index < 0 ||
      !profile ||
      !profile.providers.some((value) => value.id === provider)
    )
      throw new ServiceError("Provider worker not found", 404);
    const disabled = new Set(profile.disabledProviders);
    if (value.enabled) disabled.delete(provider as ProviderId);
    else disabled.add(provider as ProviderId);
    store.updateProfile(profile.id, { disabledProviders: [...disabled] });
    return c.json(workers().find((worker) => worker.id === id)!);
  });
  const removeProfile = (id: string) => {
    if (!store.getProfile(id)) throw new ServiceError("Profile not found", 404);
    host.disconnectProfile(id);
    store.deleteProfile(id);
    return { id, success: true };
  };
  app.delete("/api/accounts/:id", (c) =>
    c.json(removeProfile(c.req.param("id"))),
  );
  app.get("/api/jobs", (c) => {
    const status = c.req.query("status") ?? "";
    if (!["", "queued", "claimed", "succeeded", "failed"].includes(status))
      throw new ServiceError("Invalid status", 422);
    const limit = Math.max(
      1,
      Math.min(Number(c.req.query("limit")) || 100, 1000),
    );
    return c.json(
      store
        .listRequests(100000)
        .map(uiRequest)
        .filter((row) => !status || row.status === status)
        .slice(0, limit),
    );
  });
  app.get("/api/jobs/:id", (c) => {
    const record = find(c.req.param("id"));
    return c.json({
      ...uiRequest(record),
      request: record.request,
      result: record.result,
      attempts: record.attempts,
    });
  });
  app.get("/api/stats/operations", (c) => c.json(operationStats(
    store.listRequests(STATS_RECORD_LIMIT), statsQuerySchema.parse(c.req.query()),
  )));
  app.get("/api/stats", (c) => {
    const records = store.listRequests(100000),
      list = workers(),
      jobs = { queued: 0, claimed: 0, succeeded: 0, failed: 0 },
      queue = { providers: {} as Record<string, number>, auto: 0 },
      by_kind = Object.fromEntries(
        ["text", "image", "video", "audio"].map((kind) => [
          kind,
          { total: 0, successful: 0, failed: 0 },
        ]),
      ) as DashboardStats["requests"]["by_kind"];
    for (const record of records) {
      const status = uiStatus(record),
        bucket = by_kind[record.request.kind]!;
      jobs[status]++;
      if (status === "queued") {
        const model = modelSpec(record.request.options.model);
        if (record.request.options.model === "auto") queue.auto++;
        else if (model?.providerId) queue.providers[model.providerId] = (queue.providers[model.providerId] ?? 0) + 1;
      }
      bucket.total++;
      if (status === "succeeded") bucket.successful++;
      if (status === "failed") bucket.failed++;
    }
    return c.json({
      requests: {
        total: records.length,
        successful: jobs.succeeded,
        failed: jobs.failed,
        by_kind,
      },
      jobs,
      queue,
      workers: {
        total: list.length,
        online: list.filter((worker) => worker.online).length,
      },
    } satisfies DashboardStats);
  });
  app.get("/api/system/info", (c) => {
    const list = keys.listKeys();
    return c.json({
      success: true,
      info: {
        total_api_keys: list.length,
        active_api_keys: list.filter((key) => key.enabled).length,
        version: config.version,
        node: process.versions.node,
      },
    } satisfies ApiResponses["system"]);
  });
  app.get("/api/api-keys", (c) => c.json(keys.listKeys()));
  app.post("/api/api-keys", async (c) => {
    const value = z.object({ label: z.string() }).parse(await c.req.json());
    return c.json(keys.createKey(value.label), 201);
  });
  app.patch("/api/api-keys/:id", async (c) => {
    const value = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    return c.json(keys.setKeyEnabled(c.req.param("id"), value.enabled));
  });
  app.delete("/api/api-keys/:id", (c) => {
    keys.deleteKey(c.req.param("id"));
    return c.json({ id: c.req.param("id"), success: true });
  });
  const serverConfig = () => ({
      mode: config.mode,
      textProviderOrder: [...host.textRoutes],
      apiKeyConfigured: keys.listKeys().some((key) => key.enabled),
      extensionVersion: [
        ...new Set(
          store
            .listProfiles()
            .filter((profile) => host.connectedIds().has(profile.id))
            .map((profile) => profile.extensionVersion),
        ),
      ]
        .filter(Boolean)
        .join(", "),
      publicApi: {
        models: "/v1/models",
        chatCompletions: "/v1/chat/completions",
        responses: "/v1/responses",
        images: "/v1/images/generations",
        speech: "/v1/audio/speech",
        videos: "/v1/videos",
      },
    });
  app.get("/api/config", (c) => c.json(serverConfig()));
  app.get("/api/videoforge/connector", (c) => c.json(connector?.snapshot() ?? { origin: "", tokenSaved: false, enabled: false, status: "disabled" }));
  app.put("/api/videoforge/connector", async (c) => {
    if (!connector) throw new ServiceError("VideoForge connector is unavailable", 503);
    return c.json(await connector.update(await c.req.json()));
  });
  let configUpdate = Promise.resolve();
  app.patch("/api/config", async (c) => {
    const settings = settingsSchema.parse(await c.req.json());
    const update = configUpdate.then(async () => {
      await saveSettings(config.dataDir, settings);
      host.setTextProviderOrder(settings.textProviderOrder);
    });
    configUpdate = update.catch(() => {});
    await update;
    return c.json(serverConfig());
  });
  app.all("*", async (c) => {
    const first = c.req.path.split("/")[1] ?? "";
    if (first === "api" || first === "health" || /^v.*\d/.test(first))
      throw new ServiceError("Route not found", 404, "not_found");
    if (c.req.method !== "GET" && c.req.method !== "HEAD")
      return c.json({ detail: "Method not allowed" }, 405);
    if (config.mode === "server") requireUI(c);
    let path = resolve(config.webDir, c.req.path.slice(1));
    if (!path.startsWith(resolve(config.webDir) + sep))
      path = resolve(config.webDir, "index.html");
    try {
      if (!(await stat(path)).isFile())
        path = resolve(config.webDir, "index.html");
    } catch {
      path = resolve(config.webDir, "index.html");
    }
    try {
      const data = await readFile(path),
        ext = path.split(".").at(-1) ?? "",
        mime: Record<string, string> = {
          html: "text/html; charset=utf-8",
          js: "text/javascript; charset=utf-8",
          css: "text/css; charset=utf-8",
          svg: "image/svg+xml",
          png: "image/png",
          ico: "image/x-icon",
          json: "application/json",
        };
      return c.body(data, 200, {
        "Content-Type": mime[ext] ?? "application/octet-stream",
      });
    } catch {
      return c.json({ service: "webchat-ai", web_ui: "not_built" }, 503);
    }
  });
  return app;
}
function uiStatus(record: RequestRecord) {
  return record.status === "pending"
    ? "queued"
    : record.status === "running"
      ? "claimed"
      : record.status === "completed"
        ? "succeeded"
        : "failed";
}
function uiRequest(record: RequestRecord): JobRow {
  const status = uiStatus(record),
    model = modelSpec(record.request.options.model),
    result = record.result;
  const count =
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    "images" in result &&
    Array.isArray(result.images)
      ? result.images.length
      : record.status === "completed"
        ? 1
        : 0;
  return {
    id: record.id,
    request_id: record.id,
    provider_id: record.attempts.at(-1)?.provider ?? model?.providerId ?? "auto",
    kind: record.request.kind,
    model: record.request.options.model,
    status,
    broker_status: status,
    worker_id: record.profileId
      ? `${record.profileId}:${record.attempts.at(-1)?.provider ?? model?.providerId ?? ""}`
      : null,
    error_code: record.error?.code ?? null,
    error: record.error?.message ?? null,
    error_details: record.error ?? {},
    duration_ms:
      record.status === "completed" || record.status === "error"
        ? Date.parse(record.updatedAt) - Date.parse(record.createdAt)
        : null,
    api_completed_at:
      record.status === "completed" || record.status === "error"
        ? record.updatedAt
        : null,
    output_count: count,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export type ModelWorker = Pick<
  ProviderWorker,
  "provider_id" | "online" | "enabled" | "status" | "active_jobs"
>;
function eligible(model: ModelSpec, workers: ModelWorker[], routes?: readonly string[]) {
  return workers.filter(
    (worker) =>
      (model.providerId ? worker.provider_id === model.providerId : MODELS.some((entry) => entry.kind === "text" && entry.providerId === worker.provider_id && (!routes || routes.includes(entry.id)))) &&
      worker.online &&
      worker.enabled &&
      worker.status !== "error",
  );
}
export function publicModel(model: ModelSpec, workers: ModelWorker[], routes?: readonly string[]) {
  const available = eligible(model, workers, routes);
  const { providerId, ...metadata } = model;
  return {
    ...metadata,
    object: "model" as const,
    created: 0,
    owned_by: providerId === "google_vids" ? "google" : providerId ?? "webchat-ai",
    available: available.length > 0,
    capacity: {
      limit: available.length,
      active: available.filter((worker) => worker.active_jobs > 0).length,
    },
  };
}
/** Presentation needed by the owner UI; metadata comes only from contracts. */
export function uiModel(model: ModelSpec, workers: ModelWorker[], routes?: readonly string[]): ModelEntry {
  const roles = model.referenceRoles ?? [],
    modes =
      model.kind === "video"
        ? [
            "text",
            ...(roles.includes("start_frame") ? ["start"] : []),
            ...(roles.includes("end_frame") ? ["interpolation"] : []),
            ...(roles.includes("reference") ? ["reference"] : []),
          ]
        : [];
  return {
    id: model.id,
    displayName: model.label,
    description: `Browser ${model.kind} provider: ${model.providerId ? PROVIDERS[model.providerId].label : "Auto"}`,
    type: model.kind,
    available: eligible(model, workers, routes).length > 0,
    availableWorkers: eligible(model, workers, routes).length,
    capabilities: {
      provider: model.providerId ?? "auto",
      providerLabel: model.providerId ? PROVIDERS[model.providerId].label : "Auto",
      operations: [model.kind],
      aspects: [...(model.aspects ?? [])],
      sizes: [...(model.sizes ?? [])],
      durations: [...(model.durations ?? [])],
      voices: model.kind === "audio" ? VOICES.map((voice) => voice.id) : [],
      modes,
      minImages: 0,
      maxImages: model.maxReferences,
      modeImageCounts: {
        text: { min: 0, max: 0 },
        start: { min: 1, max: 1 },
        interpolation: { min: 2, max: 2 },
        reference: { min: 1, max: model.maxReferences },
      },
      referenceImageLimits: {
        maxObjects: model.maxReferences,
        maxCharacters: 0,
        maxStyles: 0,
      },
      defaults: {
        ...(model.aspects?.[0] ? { aspect: model.aspects[0] } : {}),
        ...(model.sizes?.[0] ? { size: model.sizes[0] } : {}),
        ...(model.durations?.[0] ? { duration: model.durations[0] } : {}),
        ...(model.defaultVoice ? { voice: model.defaultVoice } : {}),
      },
    },
  };
}
