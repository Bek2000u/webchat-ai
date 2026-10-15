import { Server as SocketServer, type Socket } from "socket.io";
import { type Server } from "node:http";
import {
  BRIDGE_PATH,
  helloSchema,
  resultSchema,
  requestErrorSchema,
  modelSpec,
  parseSDKRequest,
  type SDKRequest,
  type ProviderStatus,
  type RequestRecord,
  type RequestError,
  type ProviderObservation,
  DEFAULT_TEXT_ROUTES,
  FLOW_UPSCALE_TIMEOUT_MS,
  upscaleReadySchema,
} from "../shared/contracts.js";
import { ApiStore } from "./storage.js";
import { ServiceError, requestServiceError } from "./errors.js";
import { setTimeout as delay } from "node:timers/promises";
import { accountError, invalidTextError, providerMessage, textResultError, transientProviderError } from "../shared/errors.js";
import { textProviderOrderSchema } from "./settings.js";

type Connection = {
  profileId: string;
  socket: Socket;
  providers: ProviderStatus[];
};
type Running = { connection: Connection; providerId: string; attempt: number };
/** One bounded fresh-attempt policy. Reconnect is not receipt recovery. */
export class BrowserDispatcher {
  private connections = new Map<string, Connection>();
  private running = new Map<string, Running>();
  private io?: SocketServer;
  private closed = false;
  private lastProfile = new Map<string, string>();
  private observations = new Map<string, ProviderObservation>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryWake = Infinity;
  private deadlines = new Map<string, { timer: ReturnType<typeof setTimeout>; at: number; upscaleStarted: boolean }>();
  private _textRoutes: readonly string[];
  get textRoutes(): readonly string[] { return this._textRoutes; }
  constructor(
    readonly store: ApiStore,
    readonly origins: readonly string[],
    textRoutes: readonly string[] = DEFAULT_TEXT_ROUTES,
  ) {
    this._textRoutes = textProviderOrderSchema.parse(textRoutes);
  }
  setTextProviderOrder(order: readonly string[]) {
    this._textRoutes = textProviderOrderSchema.parse(order);
    this.dispatch();
  }
  modelsFor(id: string) {
    return id === "auto" ? this.textRoutes : [id];
  }
  connectedIds() {
    return new Set(this.connections.keys());
  }
  health(profileId: string, providerId: string): ProviderObservation {
    return structuredClone(this.observations.get(`${profileId}:${providerId}`) ?? {});
  }
  private observe(record: RequestRecord, error?: RequestError) {
    const attempt = record.attempts.at(-1);
    if (!attempt || record.status !== "running") return;
    const key = `${attempt.profileId}:${attempt.provider}`;
    const previous = this.observations.get(key) ?? {};
    if (error && !transientProviderError(error.code)) return;
    const at = new Date().toISOString();
    this.observations.set(key, { ...previous,
      ...(error ? { lastError: { model: attempt.model, at, error } } : {
        lastSuccess: { model: attempt.model, at },
        ...(previous.lastError?.model === attempt.model ? { lastError: undefined } : {}),
      }),
    });
  }
  submit(raw: SDKRequest) {
    const request = parseSDKRequest(raw);
    const record = this.store.createRequest(request);
    this.setDeadline(record.id, Date.parse(record.createdAt) + modelSpec(request.options.model)!.timeoutMs);
    this.dispatch();
    return this.store.getRequest(record.id)!;
  }
  /** One logical request and deadline across all bounded fresh attempts. */
  async execute(request: SDKRequest, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const record = this.submit(request);
    return this.wait(record.id, signal);
  }
  async wait(id: string, signal?: AbortSignal) {
    const original = this.store.getRequest(id);
    if (!original)
      throw new ServiceError("Request not found", 404, "request_not_found");
    const combined = signal ?? new AbortController().signal;
    try {
      for (;;) {
        combined.throwIfAborted();
        const record = this.store.getRequest(id)!;
        if (record.status === "completed") return record;
        if (record.status === "error") throw requestServiceError(record);
        await delay(50, undefined, { signal: combined });
      }
    } catch (error) {
      if (combined.aborted) {
        this.cancel(id);
        const record = this.store.getRequest(id)!;
        throw new ServiceError(
          record.error?.outcome === "not_submitted" ? "Request ended before generation was submitted" : "Request interrupted; the site outcome may be unknown",
          499,
          this.store.getRequest(id)?.error?.code ?? "outcome_unknown",
          null,
          { ...record.error, request_id: id, attempts: record.attempts },
        );
      }
      throw error;
    }
  }
  private clearDeadline(id: string) {
    clearTimeout(this.deadlines.get(id)?.timer);
    this.deadlines.delete(id);
  }
  private setDeadline(id: string, at: number, upscaleStarted = false) {
    this.clearDeadline(id);
    const timer = setTimeout(() => this.cancel(id, true), Math.max(1, at - Date.now()));
    timer.unref();
    this.deadlines.set(id, { timer, at, upscaleStarted });
  }
  private deadline(record: RequestRecord) {
    const original = Date.parse(record.createdAt) + modelSpec(record.request.options.model)!.timeoutMs;
    const deadline = this.deadlines.get(record.id);
    return deadline?.upscaleStarted ? deadline.at : Math.min(original, deadline?.at ?? original);
  }
  private dispatch() {
    if (this.closed) return;
    const busy = new Set(
      [...this.running.values()].map(
        (value) => `${value.connection.profileId}:${value.providerId}`,
      ),
    );
    for (const record of this.store.pendingRequests()) {
      if (Date.now() >= this.deadline(record)) {
        this.store.failRequest(record.id, { code: "queue_timeout", message: "Request deadline expired before dispatch", outcome: "not_submitted", retryable: false });
        this.clearDeadline(record.id);
        continue;
      }
      const last = record.attempts.at(-1);
      const candidate = this.candidates(record).find(({ connection, model }) => {
        if (busy.has(`${connection.profileId}:${model.providerId}`)) return false;
        const remaining = Date.parse(last?.retryAt ?? "") - Date.now();
        if (last?.profileId === connection.profileId && last.model === model.id && remaining > 0) {
          this.wakeForRetry(remaining);
          return false;
        }
        return true;
      });
      const connection = candidate?.connection, model = candidate?.model;
      if (
        !connection || !model?.providerId ||
        !this.store.startRequest(record.id, connection.profileId)
      )
        continue;
      const attempt = record.attempts.length + 1;
      this.store.updateAttempts(record.id, [...record.attempts, {
        number: attempt, model: model.id, provider: model.providerId,
        profileId: connection.profileId, startedAt: new Date().toISOString(),
      }]);
      this.lastProfile.set(model.providerId, connection.profileId);
      const key = `${connection.profileId}:${model.providerId}`;
      this.observations.set(key, { ...this.observations.get(key), lastAssignedAt: new Date().toISOString() });
      busy.add(`${connection.profileId}:${model.providerId}`);
      this.running.set(record.id, { connection, providerId: model.providerId, attempt });
      connection.socket.emit("execute", {
        id: record.id,
        attempt,
        request: { ...record.request, options: { ...record.request.options, model: model.id } } as SDKRequest,
      });
    }
  }
  private wakeForRetry(ms: number) {
    const wake = Date.now() + ms;
    if (wake >= this.retryWake) return;
    clearTimeout(this.retryTimer);
    this.retryWake = wake;
    this.retryTimer = setTimeout(() => { this.retryWake = Infinity; this.dispatch(); }, ms);
    this.retryTimer.unref();
  }
  private candidates(record: RequestRecord) {
    const last = record.attempts.at(-1);
    const allowSame = !!last?.error?.retryable && !accountError(last.error.code);
    const candidates = this.modelsFor(record.request.options.model).flatMap((id) => {
      const model = modelSpec(id)!;
      const profiles = [...this.connections.values()];
      const index = profiles.findIndex((value) => value.profileId === this.lastProfile.get(model.providerId!));
      const rotated = [...profiles.slice(index + 1), ...profiles.slice(0, index + 1)];
      return rotated.filter((connection) => {
        const profile = this.store.getProfile(connection.profileId);
        const provider = connection.providers.find((value) => value.id === model.providerId);
        return connection.socket.connected && profile?.enabled &&
          !profile.disabledProviders.includes(model.providerId!) && provider?.available;
      }).sort((a, b) => {
        const healthA = this.health(a.profileId, model.providerId!), healthB = this.health(b.profileId, model.providerId!);
        const observedFailure = (health: ProviderObservation) => Number(health.lastError?.model === model.id);
        return observedFailure(healthA) - observedFailure(healthB) ||
          (healthA.lastAssignedAt ?? "").localeCompare(healthB.lastAssignedAt ?? "");
      }).map((connection) => ({ connection, model }));
    });
    const fresh = candidates.filter(({ connection, model }) => !record.attempts.some((attempt) => attempt.profileId === connection.profileId && attempt.model === model.id));
    return fresh.length ? fresh : allowSame ? candidates : [];
  }
  private finishAttempt(id: string, decision: "completed" | "retry" | "failed" | "unknown", error?: RequestError) {
    const record = this.store.getRequest(id);
    if (!record || record.status !== "running") return;
    const attempts = record.attempts.map((attempt, index) => index === record.attempts.length - 1 ? {
      ...attempt, finishedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(attempt.startedAt), decision, ...(error ? { error } : {}),
    } : attempt);
    this.store.updateAttempts(id, attempts);
  }
  private failure(id: string, error: RequestError) {
    const record = this.store.getRequest(id)!;
    if (record.status !== "running") return;
    error = { ...error, message: providerMessage(error.message), provider: error.provider ?? record.attempts.at(-1)?.provider };
    this.observe(record, error);
    // Error belongs to this attempt. Retrying is a new generation, not recovery.
    this.finishAttempt(id, "failed", error);
    const updated = this.store.getRequest(id)!;
    const invalidText = record.request.kind === "text" && invalidTextError(error.code);
    const transportFailures = updated.attempts.filter(attempt => attempt.error && !(record.request.kind === "text" && invalidTextError(attempt.error.code))).length;
    const canRetry = error.retryable === true &&
      updated.attempts.length < (record.request.kind === "text" ? 3 : 2) &&
      (invalidText || transportFailures <= 1);
    if (canRetry && this.candidates(updated).length &&
        Date.now() < this.deadline(record)) {
      this.finishAttempt(id, "retry", error);
      const attempts = this.store.getRequest(id)!.attempts;
      // This is a short request-local retry delay, never an account cooldown.
      attempts[attempts.length - 1].retryAt = new Date(Date.now() + 500).toISOString();
      this.store.updateAttempts(id, attempts);
      this.store.retryRequest(id);
    } else {
      this.finishAttempt(id, error.outcome === "unknown" || error.code === "outcome_unknown" ? "unknown" : "failed", error);
      this.store.failRequest(id, error);
      this.clearDeadline(id);
    }
  }
  attach(server: Server) {
    this.io = new SocketServer(server, {
      path: BRIDGE_PATH,
      transports: ["websocket"],
      maxHttpBufferSize: 2 * 1024 * 1024,
      allowRequest: (request, done) =>
        done(
          null,
          !!request.headers.origin &&
            this.origins.includes(request.headers.origin),
        ),
    });
    this.io.on("connection", (socket) => {
      let connection: Connection | undefined;
      socket.on("hello", (raw) => {
        if (connection && connection.profileId !== raw?.profileId) {
          socket.disconnect(true);
          return;
        }
        const parsed = helloSchema.safeParse(raw);
        if (!parsed.success) {
          socket.disconnect(true);
          return;
        }
        const value = parsed.data;
        // A stale extension must not advertise credit-limited Vids as ready.
        for (const provider of value.providers) {
          if (provider.id !== "google_vids" || !provider.available || provider.accountTier === "paid") continue;
          provider.available = false;
          provider.error = {
            code: provider.accountTier === "free" ? "GOOGLE_VIDS_PAID_PLAN_REQUIRED" : "GOOGLE_VIDS_PLAN_PENDING",
            message: provider.accountTier === "free" ? "Google Vids voiceover requires an unlimited paid account" : "Google Vids voiceover plan was not detected",
            provider: "google_vids", stage: "account", outcome: "not_submitted", retryable: false,
          };
        }
        // The allowed local extension registers itself; there is no pairing step.
        if (!this.store.getProfile(value.profileId))
          this.store.createProfile(value.profileId, value.token);
        if (!this.store.authenticateProfile(value.profileId, value.token)) {
          socket.disconnect(true);
          return;
        }
        const previous = this.connections.get(value.profileId);
        for (const provider of value.providers) {
          const previousProvider = this.store.getProfile(value.profileId)?.providers.find(item => item.id === provider.id);
          if (previousProvider?.accountSubject && provider.accountSubject && previousProvider.accountSubject !== provider.accountSubject)
            this.observations.delete(`${value.profileId}:${provider.id}`);
        }
        if (previous && previous.socket !== socket)
          previous.socket.disconnect(true);
        connection = {
          profileId: value.profileId,
          socket,
          providers: value.providers,
        };
        this.connections.set(value.profileId, connection);
        this.store.registerProfile(
          value.profileId,
          value.extensionVersion,
          value.providers,
          value.browserIdentity,
        );
        this.dispatch();
      });
      socket.on("upscale_ready", (raw, acknowledge) => {
        const parsed = upscaleReadySchema.safeParse(raw);
        if (typeof acknowledge !== "function") return;
        if (!parsed.success) { acknowledge(false); return; }
        const { id, attempt } = parsed.data;
        const running = this.running.get(id), record = this.store.getRequest(id), deadline = this.deadlines.get(id);
        if (!running || running.connection.socket !== socket || running.attempt !== attempt || running.providerId !== "flow" ||
            !record || record.status !== "running" || !["image", "video"].includes(record.request.kind) || !deadline || Date.now() >= this.deadline(record)) {
          acknowledge(false); return;
        }
        if (!deadline.upscaleStarted) {
          this.setDeadline(id, Date.now() + FLOW_UPSCALE_TIMEOUT_MS, true);
          const attempts = record.attempts;
          attempts[attempts.length - 1].upscaleReadyAt = new Date().toISOString();
          this.store.updateAttempts(id, attempts);
        }
        acknowledge(true);
      });
      socket.on("result", (raw) => {
        const parsed = resultSchema.safeParse(raw);
        if (
          !parsed.success ||
          !connection ||
          this.running.get(parsed.data.id)?.connection.socket !== socket ||
          this.running.get(parsed.data.id)?.attempt !== (parsed.data.attempt ?? 1)
        )
          return;
        const record = this.store.getRequest(parsed.data.id)!;
        const invalid = record.request.kind === "text" ? textResultError(parsed.data.result, Boolean(record.request.options.outputSchema)) : undefined;
        if (invalid) this.failure(parsed.data.id, invalid);
        else {
          this.observe(record);
          this.finishAttempt(parsed.data.id, "completed");
          this.store.completeRequest(parsed.data.id, parsed.data.result);
          this.clearDeadline(parsed.data.id);
        }
        this.running.delete(parsed.data.id);
        this.dispatch();
      });
      socket.on("error", (raw: unknown) => {
        const error = requestErrorSchema.safeParse(raw);
        if (
          !error.success ||
          !connection ||
          this.running.get(error.data.id)?.connection.socket !== socket ||
          this.running.get(error.data.id)?.attempt !== (error.data.attempt ?? 1)
        )
          return;
        this.failure(error.data.id, error.data.error);
        this.running.delete(error.data.id);
        this.dispatch();
      });
      socket.on("disconnect", () => {
        if (!connection) return;
        if (this.connections.get(connection.profileId)?.socket === socket)
          this.connections.delete(connection.profileId);
        for (const [id, running] of this.running)
          if (running.connection.socket === socket) {
            const error: RequestError = {
              code: "outcome_unknown",
              message: "Chrome disconnected while executing this request",
              outcome: "unknown", retryable: true,
            };
            this.failure(id, error);
            this.running.delete(id);
          }
        this.dispatch();
      });
    });
  }
  cancel(id: string, timedOut = false) {
    const record = this.store.getRequest(id);
    if (!record) return;
    if (record.status === "pending")
      this.store.failRequest(id, {
        code: timedOut ? "queue_timeout" : "cancelled",
        message: timedOut ? "Request deadline expired before execution" : "Cancelled before execution",
        outcome: "not_submitted", retryable: timedOut,
      });
    else if (record.status === "running") {
      const error: RequestError = {
        code: timedOut ? "EXTENSION_TIMEOUT" : "outcome_unknown",
        message: timedOut ? "Request deadline expired; the provider may still be generating" : "Execution was interrupted; the site outcome is unknown",
        outcome: "unknown", retryable: timedOut,
        provider: record.attempts.at(-1)?.provider,
      };
      this.finishAttempt(id, "unknown", error);
      this.store.failRequest(id, error);
      this.running.get(id)?.connection.socket.emit("cancel", { id });
    }
    this.clearDeadline(id);
    return this.store.getRequest(id);
  }
  authorizeFile(profileId: string, token: string, id: string) {
    const running = this.running.get(id);
    return (
      !!this.store.authenticateProfile(profileId, token) &&
      running?.connection.profileId === profileId &&
      running.connection.socket.connected &&
      this.store.getRequest(id)?.status === "running"
    );
  }
  disconnectProfile(id: string) {
    this.connections.get(id)?.socket.disconnect(true);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.deadlines.forEach(({ timer }) => clearTimeout(timer));
    this.deadlines.clear();
    for (const connection of this.connections.values())
      connection.socket.disconnect(true);
    this.connections.clear();
    if (this.io)
      await new Promise<void>((resolve) => this.io!.close(() => resolve()));
  }
}
