import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { VideoForgeConnectorState } from "../shared/contracts.js";
import { ServiceError } from "./errors.js";

export const CONNECTOR_BODY_LIMIT = 64 * 1024 * 1024;
export const CONNECTOR_MEDIA_LIMIT = 512 * 1024 * 1024;
export const CONNECTOR_CHUNK_LIMIT = 1024 * 1024;
const originSchema = z.string().transform((value, ctx) => {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
        !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error();
    return url.origin;
  } catch {
    ctx.addIssue({ code: "custom", message: "Укажите HTTPS-адрес VideoForge без пути; HTTP разрешён только для localhost" });
    return z.NEVER;
  }
});
const configSchema = z.object({ origin: originSchema, token: z.string().max(4096), enabled: z.boolean() }).strict();
export const connectorUpdateSchema = z.object({ origin: originSchema, token: z.string().trim().min(1).max(4096).optional(), enabled: z.boolean() }).strict();
const requestSchema = z.object({ type: z.literal("request"), id: z.string().min(1).max(256), method: z.enum(["GET", "POST", "DELETE"]), path: z.string().max(8192), headers: z.record(z.string(), z.string().max(8192)).default({}), body: z.string().default("") }).strict();
type RelayRequest = z.infer<typeof requestSchema>;
type RelayResponse = { type: "response"; id: string; status: number; headers: Record<string, string>; body: string };
type RelayError = { type: "error"; id: string; code: string; message: string };
type RelayResult = RelayResponse | RelayError;
type MediaFrame = { type: "response_start"; id: string; status: number; headers: Record<string, string> }
  | { type: "response_chunk"; id: string; body: string }
  | { type: "response_end"; id: string };
type JournalRow = { fingerprint: string; response: string | null };
type Options = {
  db: DatabaseSync;
  dataDir: string;
  apiKey: string;
  fetch: (request: Request) => Response | Promise<Response>;
  webSocketFactory?: (url: string) => WebSocket;
  reconnectDelays?: number[];
};
const requestHeaders = new Set(["content-type", "accept", "range", "if-none-match", "if-modified-since"]);
const responseHeaders = new Set(["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "content-disposition", "x-request-id", "x-should-retry"]);

/** Only the existing public API, never desktop controls or a remote URL. */
export function connectorPathAllowed(method: string, path: string) {
  if (!path.startsWith("/v1/") || /[\\#\s]/.test(path)) return false;
  const url = new URL(path, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || url.pathname + url.search !== path) return false;
  const segment = "[A-Za-z0-9_:-][A-Za-z0-9_.:-]*";
  return method === "GET"
    ? new RegExp(`^/v1/(models(?:/${segment})?|audio/voices|videos/${segment}(?:/content)?|files/${segment})$`).test(url.pathname)
    : method === "POST" && /^\/v1\/(chat\/completions|responses|images\/(generations|edits)|audio\/speech|videos)$/.test(url.pathname);
}

/** An outgoing transport. BrowserDispatcher remains the sole execution/retry owner. */
export class VideoForgeConnector {
  private config: z.infer<typeof configSchema> = { origin: "", token: "", enabled: false };
  private status: VideoForgeConnectorState["status"] = "disabled";
  private error = "";
  private connectionId = "";
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private authTimer?: ReturnType<typeof setTimeout>;
  private active = false;
  private attempt = 0;
  private updates = Promise.resolve();
  private readonly inFlight = new Map<string, { promise: Promise<RelayResult | undefined>; controller: AbortController; method: string }>();
  private constructor(private readonly options: Options) {
    if (!options.apiKey) throw Error("Connector requires an internal local API key");
    options.db.exec(`CREATE TABLE IF NOT EXISTS videoforge_connector_requests (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      response TEXT, created_at TEXT NOT NULL, PRIMARY KEY(scope,request_id)
    )`);
  }
  static async open(options: Options) {
    const connector = new VideoForgeConnector(options);
    try {
      connector.config = configSchema.parse(JSON.parse(await readFile(join(options.dataDir, "videoforge-connector.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (connector.config.enabled && (!connector.config.origin || !connector.config.token)) throw Error("Invalid VideoForge connector configuration");
    return connector;
  }
  snapshot(): VideoForgeConnectorState {
    return { origin: this.config.origin, tokenSaved: !!this.config.token, enabled: this.config.enabled, status: this.status,
      ...(this.connectionId ? { connectionId: this.connectionId } : {}), ...(this.error ? { error: this.error } : {}) };
  }
  start() {
    if (this.active) return;
    this.active = true;
    if (this.config.enabled) this.connect();
  }
  async update(value: unknown) {
    const input = connectorUpdateSchema.parse(value);
    const update = this.updates.then(async () => {
      const token = input.token ?? (input.origin === this.config.origin ? this.config.token : "");
      if (input.enabled && (!input.origin || !token)) throw new ServiceError("Укажите адрес VideoForge и connector token", 400);
      const next = { origin: input.origin, token, enabled: input.enabled };
      await mkdir(this.options.dataDir, { recursive: true });
      const temporary = join(this.options.dataDir, `.videoforge-connector-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flush: true });
        await rename(temporary, join(this.options.dataDir, "videoforge-connector.json"));
      } finally { await unlink(temporary).catch(() => {}); }
      this.disconnect();
      for (const work of this.inFlight.values()) work.controller.abort();
      this.config = next;
      this.error = "";
      this.status = next.enabled ? "disconnected" : "disabled";
      this.attempt = 0;
      if (this.active && next.enabled) this.connect();
    });
    this.updates = update.catch(() => {});
    await update;
    return this.snapshot();
  }
  async close() {
    this.active = false;
    this.disconnect();
    for (const work of this.inFlight.values()) work.controller.abort();
    await Promise.allSettled([...this.inFlight.values()].map((work) => work.promise));
    this.status = this.config.enabled ? "disconnected" : "disabled";
  }
  private disconnect() {
    clearTimeout(this.timer);
    clearTimeout(this.authTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.connectionId = "";
    socket?.close();
  }
  private connect() {
    if (!this.active || !this.config.enabled || this.socket) return;
    this.status = "connecting";
    const url = new URL("/api/ai/connectors/connect", this.config.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try { socket = (this.options.webSocketFactory ?? ((address) => new WebSocket(address)))(url.href); }
    catch { this.retry("Не удалось открыть соединение с VideoForge"); return; }
    this.socket = socket;
    let ready = false;
    this.authTimer = setTimeout(() => { if (this.socket === socket && !ready) socket.close(); }, 15_000);
    this.authTimer.unref?.();
    socket.addEventListener("open", () => {
      if (this.socket === socket) socket.send(JSON.stringify({ type: "authenticate", version: 1, token: this.config.token }));
    });
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket || typeof event.data !== "string") return;
      if (Buffer.byteLength(event.data) > Math.ceil(CONNECTOR_BODY_LIMIT * 4 / 3) + 64 * 1024) { socket.close(1009); return; }
      let message: unknown;
      try { message = JSON.parse(event.data); } catch { socket.close(1008); return; }
      if (!ready) {
        const parsed = z.object({ type: z.literal("ready"), version: z.literal(1), connectionId: z.string().min(1).max(256) }).safeParse(message);
        if (!parsed.success) { this.error = "VideoForge отклонил connector token или версию протокола"; socket.close(1008); return; }
        ready = true;
        clearTimeout(this.authTimer);
        this.connectionId = parsed.data.connectionId;
        this.status = "connected";
        this.error = "";
        this.attempt = 0;
        return;
      }
      const cancel = z.object({ type: z.literal("cancel"), id: z.string().min(1).max(256) }).safeParse(message);
      const scope = JSON.stringify([this.config.origin, this.connectionId]);
      if (cancel.success) { this.inFlight.get(JSON.stringify([scope, cancel.data.id]))?.controller.abort(); return; }
      const request = requestSchema.safeParse(message);
      if (!request.success) { socket.close(1008); return; }
      const emit = (frame: RelayResult | MediaFrame) => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(frame));
        return true;
      };
      let work: Promise<RelayResult | undefined>;
      try { work = this.relay(scope, request.data, emit, socket); }
      catch { socket.close(1011); return; }
      void work.then((result) => {
        if (result) emit(result);
      }).catch(() => { if (this.socket === socket) socket.close(1011); });
    });
    socket.addEventListener("error", () => { if (this.socket === socket) socket.close(); });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connectionId = "";
      clearTimeout(this.authTimer);
      for (const work of this.inFlight.values()) if (work.method === "GET") work.controller.abort();
      this.retry(this.error || "Соединение с VideoForge прервано; повторное подключение автоматически");
    });
  }
  private retry(message: string) {
    if (!this.active || !this.config.enabled) return;
    this.status = "disconnected";
    this.error = message;
    const delays = this.options.reconnectDelays ?? [500, 1000, 2000, 5000, 10_000, 30_000];
    this.timer = setTimeout(() => this.connect(), delays[Math.min(this.attempt++, delays.length - 1)] ?? 30_000);
    this.timer.unref?.();
  }
  private relay(scope: string, request: RelayRequest, emit: (frame: MediaFrame) => boolean, socket: WebSocket): Promise<RelayResult | undefined> {
    const fail = (code: string, message: string): RelayError => ({ type: "error", id: request.id, code, message });
    if (!connectorPathAllowed(request.method, request.path)) return Promise.resolve(fail("route_not_allowed", "Only the public local /v1 API is available"));
    if (request.body.length > Math.ceil(CONNECTOR_BODY_LIMIT * 4 / 3) || request.body.length % 4 || /[^A-Za-z0-9+/=]/.test(request.body)) return Promise.resolve(fail("invalid_body", "Expected a base64 body up to 64 MiB"));
    const body = Buffer.from(request.body, "base64");
    if (body.length > CONNECTOR_BODY_LIMIT || body.toString("base64") !== request.body || (request.method === "GET" && body.length)) return Promise.resolve(fail("invalid_body", "Invalid request body"));
    const headers = new Headers();
    try {
      for (const [key, value] of Object.entries(request.headers)) if (requestHeaders.has(key.toLowerCase())) headers.set(key.toLowerCase(), value);
    } catch { return Promise.resolve(fail("invalid_headers", "Invalid public API headers")); }
    const fingerprint = createHash("sha256").update(JSON.stringify([request.method, request.path, [...headers.entries()].sort()])).update(body).digest("hex");
    const key = JSON.stringify([scope, request.id]);
    if (request.method === "POST") {
      const row = this.options.db.prepare("SELECT fingerprint,response FROM videoforge_connector_requests WHERE scope=? AND request_id=?").get(scope, request.id) as JournalRow | undefined;
      if (row) {
        if (row.fingerprint !== fingerprint) return Promise.resolve(fail("request_conflict", "Request ID was already used with different content"));
        if (row.response) return Promise.resolve(JSON.parse(row.response) as RelayResult);
        return this.inFlight.get(key)?.promise ?? Promise.resolve(fail("outcome_unknown", "The original local API outcome is unknown; it was not submitted again"));
      }
      // A durable claim precedes every side-effecting local API dispatch.
      this.options.db.prepare("INSERT INTO videoforge_connector_requests VALUES (?,?,?,?,?)").run(scope, request.id, fingerprint, null, new Date().toISOString());
    } else if (this.inFlight.has(key)) return Promise.resolve(fail("request_conflict", "Request ID is already executing"));
    const controller = new AbortController();
    const promise = Promise.resolve().then(async (): Promise<RelayResult | undefined> => {
      try {
        controller.signal.throwIfAborted();
        headers.set("authorization", `Bearer ${this.options.apiKey}`);
        const response = await this.options.fetch(new Request(new URL(request.path, "http://127.0.0.1"), { method: request.method, headers,
          ...(request.method === "POST" ? { body } : {}), signal: controller.signal, redirect: "error" }));
        const resultHeaders: Record<string, string> = {};
        for (const [name, value] of response.headers) if (responseHeaders.has(name.toLowerCase())) resultHeaders[name.toLowerCase()] = value;
        if (request.method === "GET" && /^\/v1\/(files\/[^/?]+|videos\/[^/?]+\/content)(?:\?|$)/.test(request.path)) {
          const reader = response.body?.getReader();
          const abort = () => { void reader?.cancel().catch(() => {}); };
          controller.signal.addEventListener("abort", abort, { once: true });
          let bytes = 0;
          try {
            const declared = Number(response.headers.get("content-length"));
            if (Number.isFinite(declared) && declared > CONNECTOR_MEDIA_LIMIT) throw Error("Media response too large");
            controller.signal.throwIfAborted();
            if (!emit({ type: "response_start", id: request.id, status: response.status, headers: resultHeaders })) throw Error("Socket closed");
            if (reader) while (true) {
              const { value, done } = await reader.read();
              controller.signal.throwIfAborted();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > CONNECTOR_MEDIA_LIMIT) throw Error("Media response too large");
              for (let offset = 0; offset < value.byteLength; offset += CONNECTOR_CHUNK_LIMIT) {
                while (socket.bufferedAmount > 4 * CONNECTOR_CHUNK_LIMIT) {
                  controller.signal.throwIfAborted();
                  if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw Error("Socket closed");
                  await new Promise<void>((done) => setTimeout(done, 10));
                }
                controller.signal.throwIfAborted();
                if (!emit({ type: "response_chunk", id: request.id, body: Buffer.from(value.subarray(offset, offset + CONNECTOR_CHUNK_LIMIT)).toString("base64") })) throw Error("Socket closed");
              }
            }
            if (!emit({ type: "response_end", id: request.id })) throw Error("Socket closed");
          } finally {
            controller.signal.removeEventListener("abort", abort);
            if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          }
          return undefined;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body?.getReader();
        if (reader) try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > CONNECTOR_BODY_LIMIT) { await reader.cancel(); throw Error("Response too large"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        return { type: "response", id: request.id, status: response.status, headers: resultHeaders, body: Buffer.concat(chunks).toString("base64") };
      } catch {
        return fail(request.method === "POST" ? "outcome_unknown" : "local_request_failed", "Local API request did not complete; no connector retry was made");
      }
    }).then((result) => {
      if (request.method === "POST" && result) this.options.db.prepare("UPDATE videoforge_connector_requests SET response=? WHERE scope=? AND request_id=?").run(JSON.stringify(result), scope, request.id);
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { promise, controller, method: request.method });
    return promise;
  }
}
