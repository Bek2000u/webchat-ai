import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

type HeaderPair = [string, string];
interface CapturedTransport {
  url: string;
  headers: HeaderPair[];
  capturedAt: number;
}
interface ManagedResult {
  ok: boolean;
  code?: string;
  message?: string;
  submitted: boolean;
  uri?: string;
  mimeType?: string;
  status?: number;
  cancelled?: boolean;
}
interface NativeXhr {
  xhr: XMLHttpRequest;
  sourcePath: string;
  capturedAt: number;
}
interface CaptureState {
  installed?: boolean;
  observerVersion?: number;
  transport: CapturedTransport | null;
  voiceoverAccess: {
    access: string;
    creditsTotal: number;
    creditsRemaining: number;
    checkedAt: string;
  } | null;
  nativeXhrs: NativeXhr[];
  managedXhrs: WeakSet<XMLHttpRequest>;
  cancelled: Set<string>;
  active: Map<string, XMLHttpRequest>;
  results: Map<string, { completedAt: number; result: ManagedResult }>;
  execute?(callId: string, body: string): Promise<ManagedResult>;
  abort?(callId: string): void;
}
export default defineUnlistedScript(() => {
  const page = globalThis as typeof globalThis &
    Record<symbol, CaptureState | undefined>;
  const stateKey = Symbol.for("workspaceCompanion.googleVids.transport.v1");
  const markerName = "data-workspace-companion-google-vids-driver";
  const markerValue = "native-v5";
  const markObserver = () => {
    if (typeof document !== "undefined") {
      document.documentElement?.setAttribute(markerName, markerValue);
    }
  };
  markObserver();
  if (typeof document !== "undefined" && !document.documentElement) {
    document.addEventListener?.("readystatechange", markObserver, {
      once: true,
    });
  }

  const existing: CaptureState = page[stateKey] || {
    transport: null,
    voiceoverAccess: null,
    nativeXhrs: [],
    managedXhrs: new WeakSet(),
    cancelled: new Set(),
    active: new Map(),
    results: new Map(),
  };
  if (existing.observerVersion === 5) return;

  // Request credentials and reusable native XHR objects deliberately remain
  // only in the Google Vids page's MAIN world. They are never copied to
  // extension storage, logs, messages or the service worker.
  const state = existing;
  state.installed = true;
  state.observerVersion = 5;
  state.transport = null;
  state.voiceoverAccess ||= null;
  state.nativeXhrs = [];
  state.managedXhrs = new WeakSet();
  state.cancelled = new Set();
  state.active = new Map();
  state.results = new Map();
  Object.defineProperty(globalThis, stateKey, {
    value: state,
    configurable: true,
  });

  const requests = new WeakMap<
    XMLHttpRequest,
    {
      method: string;
      url: string;
      sourcePath: string;
      target: boolean;
      managed: boolean;
      headers: HeaderPair[];
    }
  >();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalFetch = globalThis.fetch;
  const allowedHeaders = new Set([
    "accept",
    "accept-language",
    // Native Vids requests explicitly set this header. Cookies alone return
    // HTTP 401; preserve its value only in this page's private transport.
    "authorization",
    "content-type",
    "x-browser-channel",
    "x-browser-copyright",
    "x-browser-validation",
    "x-browser-year",
    "x-client-data",
    "x-goog-authuser",
    "x-server-token",
  ]);

  function parsedTarget(url: string | URL) {
    try {
      const parsed = new URL(String(url), location.href);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "appsgenaiserver-pa.clients6.google.com" ||
        !/^\/v1\/genai\/(?:generate|quotaSummary|writeAuditLog)$/.test(
          parsed.pathname,
        )
      )
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function isQuotaSummary(url: string) {
    return parsedTarget(url)?.pathname === "/v1/genai/quotaSummary";
  }

  function capturedTransport(
    method: string,
    url: string,
    headers: Headers,
  ): CapturedTransport | null {
    const target = parsedTarget(url);
    if (
      String(method || "GET").toUpperCase() !== "POST" ||
      !target ||
      !["/v1/genai/generate", "/v1/genai/quotaSummary"].includes(
        target.pathname,
      ) ||
      !target.searchParams.has("key")
    )
      return null;
    const captured = [...headers.entries()]
      .filter(([name]) => allowedHeaders.has(String(name).toLowerCase()))
      .map(([name, value]): HeaderPair => [String(name), String(value)]);
    if (
      !captured.some(
        ([name, value]) =>
          String(name).toLowerCase() === "x-server-token" && value,
      )
    )
      return null;
    return {
      url: target.toString(),
      headers: captured,
      capturedAt: Date.now(),
    };
  }

  function rememberNativeXhr(xhr: XMLHttpRequest, sourcePath: string) {
    if (state.managedXhrs.has(xhr)) return;
    const previous = state.nativeXhrs.findIndex(
      (candidate: NativeXhr) => candidate?.xhr === xhr,
    );
    if (previous >= 0) state.nativeXhrs.splice(previous, 1);
    state.nativeXhrs.push({ xhr, sourcePath, capturedAt: Date.now() });
    while (state.nativeXhrs.length > 8) state.nativeXhrs.shift();
  }

  function observeVoiceoverAccess(requestText: unknown, responseText: unknown) {
    try {
      const request = JSON.parse(String(requestText || ""));
      if (
        !Array.isArray(request) ||
        request.length !== 3 ||
        request[0] !== null ||
        request[1] !== 1 ||
        !Array.isArray(request[2]) ||
        request[2].length !== 1 ||
        request[2][0] !== 9
      )
        return;
      // A new quota response invalidates the previous entitlement, including
      // when Google changes the response shape after an account/plan change.
      state.voiceoverAccess = null;
      const response = JSON.parse(String(responseText || ""));
      const quota = response?.[0]?.[1];
      const total = Number(quota?.[0]);
      const remaining = Number(quota?.[2]);
      const mode = Number(quota?.[3]);
      if (
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(remaining) ||
        total < 0 ||
        remaining < 0 ||
        remaining > total
      )
        return;
      const access =
        mode === 3 && total >= 999999 && remaining >= 999999
          ? "unlimited"
          : mode === 1 && total < 999999
            ? "credit"
            : "";
      if (!access) return;
      state.voiceoverAccess = {
        access,
        creditsTotal: total,
        creditsRemaining: remaining,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      // Quota metadata remains optional until Google returns the known shape.
    }
  }

  async function executeManagedRequest(
    callId: string,
    body: string,
  ): Promise<ManagedResult> {
    if (!state.transport) {
      return {
        ok: false,
        code: "GOOGLE_VIDS_TRANSPORT_NOT_READY",
        message: "Google Vids native credentials are not ready",
        submitted: false,
      };
    }
    const cached = state.results.get(callId);
    if (cached && Date.now() - cached.completedAt < 30 * 60 * 1000) {
      return cached.result;
    }

    let endpoint;
    try {
      endpoint = new URL(state.transport.url);
    } catch {
      return {
        ok: false,
        code: "GOOGLE_VIDS_TRANSPORT_INVALID",
        message: "Google Vids transport URL is invalid",
        submitted: false,
      };
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "appsgenaiserver-pa.clients6.google.com" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.port ||
      !endpoint.searchParams.has("key")
    ) {
      return {
        ok: false,
        code: "GOOGLE_VIDS_TRANSPORT_INVALID",
        message: "Google Vids transport origin is invalid",
        submitted: false,
      };
    }
    endpoint.pathname = "/v1/genai/generate";
    const headers = (
      Array.isArray(state.transport.headers) ? state.transport.headers : []
    ).filter(([name]: [string, string]) =>
      allowedHeaders.has(String(name).toLowerCase()),
    );
    if (
      !headers.some(
        ([name, value]: [string, string]) =>
          String(name).toLowerCase() === "x-server-token" && String(value),
      )
    ) {
      return {
        ok: false,
        code: "GOOGLE_VIDS_TRANSPORT_INVALID",
        message: "Google Vids page exposed no server token",
        submitted: false,
      };
    }

    let seed: NativeXhr | null = null;
    let xhr: XMLHttpRequest | null = null;
    while (state.nativeXhrs.length && !xhr) {
      let index = -1;
      for (let cursor = state.nativeXhrs.length - 1; cursor >= 0; cursor -= 1) {
        if (
          state.nativeXhrs[cursor]?.sourcePath === "/v1/genai/writeAuditLog"
        ) {
          index = cursor;
          break;
        }
      }
      seed = state.nativeXhrs.splice(
        index >= 0 ? index : state.nativeXhrs.length - 1,
        1,
      )[0];
      const candidate = seed?.xhr || seed;
      if (
        candidate &&
        typeof candidate.open === "function" &&
        typeof candidate.setRequestHeader === "function" &&
        typeof candidate.send === "function" &&
        typeof candidate.abort === "function"
      )
        xhr = candidate;
    }
    if (!xhr) {
      return {
        ok: false,
        code: "GOOGLE_VIDS_TRANSPORT_NOT_READY",
        message: "Google Vids exposed no reusable native request",
        submitted: false,
      };
    }

    state.managedXhrs.add(xhr);
    state.active.set(callId, xhr);
    let reusable = true;
    const clearHandlers = () => {
      xhr.onreadystatechange = null;
      xhr.onload = null;
      xhr.onloadend = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
    };
    const isCancelled = () => state.cancelled.has(callId);
    const runRequest = () =>
      new Promise<{
        event: string;
        sent: boolean;
        status: number;
        responseText: string;
      }>((resolve) => {
        let outcome = { event: "unknown", sent: false };
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          let status = 0;
          let responseText = "";
          try {
            status = Number(xhr.status || 0);
            if (outcome.event === "load") {
              responseText = String(xhr.responseText || "");
            }
          } catch {
            // A detached XHR has no readable status or response body.
          }
          clearHandlers();
          resolve({ ...outcome, status, responseText });
        };
        try {
          clearHandlers();
          xhr.open("POST", endpoint.toString());
          for (const [name, value] of headers)
            xhr.setRequestHeader(name, value);
          xhr.withCredentials = true;
          xhr.responseType = "text";
          xhr.timeout = 300000;
          xhr.onload = () => {
            outcome.event = "load";
          };
          xhr.onerror = () => {
            outcome.event = "error";
          };
          xhr.ontimeout = () => {
            outcome.event = "timeout";
          };
          xhr.onabort = () => {
            outcome.event = "abort";
          };
          xhr.onloadend = finish;
          xhr.send(body);
          outcome.sent = true;
        } catch {
          reusable = false;
          outcome.event = "local-error";
          finish();
        }
      });
    const release = () => {
      clearHandlers();
      state.active.delete(callId);
      state.cancelled.delete(callId);
      if (
        reusable &&
        seed &&
        !state.nativeXhrs.some(
          (candidate: NativeXhr) => (candidate?.xhr || candidate) === xhr,
        )
      ) {
        state.nativeXhrs.push(seed);
        while (state.nativeXhrs.length > 8) state.nativeXhrs.shift();
      }
    };

    try {
      if (isCancelled()) {
        return {
          ok: false,
          code: "GOOGLE_VIDS_CANCELLED",
          message: "Google Vids request was cancelled",
          submitted: false,
          cancelled: true,
        };
      }
      const generated = await runRequest();
      if (generated.event === "abort" || isCancelled()) {
        return {
          ok: false,
          code: "GOOGLE_VIDS_CANCELLED",
          message: "Google Vids request was cancelled",
          submitted: generated.sent,
          cancelled: true,
        };
      }
      if (generated.event !== "load") {
        return {
          ok: false,
          code: generated.sent
            ? "GOOGLE_VIDS_SUBMISSION_OUTCOME_UNKNOWN"
            : "GOOGLE_VIDS_TRANSPORT_NOT_READY",
          message:
            generated.event === "timeout"
              ? "Google Vids request timed out after submission"
              : generated.sent
                ? "Google Vids request failed after submission"
                : "Google Vids native request could not start",
          submitted: generated.sent,
        };
      }
      if (generated.status !== 200) {
        const status = generated.status;
        const code =
          status === 429
            ? "GOOGLE_VIDS_QUOTA_EXCEEDED"
            : status === 401 || status === 403
              ? "GOOGLE_VIDS_ACCESS_DENIED"
              : status === 400
                ? "GOOGLE_VIDS_REQUEST_INVALID"
                : "GOOGLE_VIDS_HTTP_ERROR";
        const rejectedBeforeGeneration = [400, 401, 403, 429].includes(status);
        if (status === 401 || status === 403) {
          reusable = false;
          state.transport = null;
          state.nativeXhrs.length = 0;
        }
        return {
          ok: false,
          code,
          message: `Google Vids returned HTTP ${status}`,
          status,
          submitted: !rejectedBeforeGeneration,
        };
      }

      let parsed;
      try {
        parsed = JSON.parse(generated.responseText);
      } catch {
        return {
          ok: false,
          code: "GOOGLE_VIDS_RESPONSE_INVALID",
          message: "Google Vids returned invalid JSON",
          submitted: true,
        };
      }
      const media = parsed?.[0]?.[0]?.[0]?.[0]?.[7]?.[0];
      const mimeType = String(media?.[1] || "");
      const uri = String(media?.[2] || "");
      let artifact;
      try {
        artifact = new URL(uri);
      } catch {
        artifact = null;
      }
      if (
        mimeType !== "audio/wav" ||
        artifact?.protocol !== "https:" ||
        artifact.hostname !== "contribution-qw.usercontent.google.com" ||
        artifact.pathname !== "/download" ||
        artifact.username ||
        artifact.password ||
        artifact.port
      ) {
        return {
          ok: false,
          code: "GOOGLE_VIDS_AUDIO_MISSING",
          message: "Google Vids response contains no valid WAV artifact",
          submitted: true,
        };
      }
      const result = {
        ok: true,
        uri: artifact.toString(),
        mimeType,
        submitted: true,
      };
      state.results.set(callId, { completedAt: Date.now(), result });
      while (state.results.size > 32) {
        state.results.delete(state.results.keys().next().value!);
      }
      return result;
    } finally {
      release();
    }
  }

  // Schedule execution separately from the extension's readiness probe.
  // Authorization is explicitly replayed from the captured native headers.
  state.execute = (callId: string, body: string) =>
    new Promise<ManagedResult>((resolve) => {
      setTimeout(() => {
        void executeManagedRequest(callId, body).then(resolve, () =>
          resolve({
            ok: false,
            code: "GOOGLE_VIDS_TRANSPORT_NOT_READY",
            message: "Google Vids native request could not start",
            submitted: false,
          }),
        );
      }, 0);
    });
  state.abort = (callId: string) => {
    state.cancelled.add(callId);
    state.active.get(callId)?.abort();
  };

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const target = parsedTarget(url);
    requests.set(this, {
      method: String(method || ""),
      url: String(url),
      sourcePath: target?.pathname || "",
      target: Boolean(target),
      managed: state.managedXhrs.has(this),
      headers: [],
    });
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (
    name: string,
    value: string,
  ) {
    const request = requests.get(this);
    if (request?.target) request.headers.push([String(name), String(value)]);
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const request = requests.get(this);
    if (request?.target && request.method.toUpperCase() === "POST") {
      const transport = capturedTransport(
        request.method,
        request.url,
        new Headers(request.headers),
      );
      if (!request.managed) {
        const xhr = this;
        xhr.addEventListener(
          "loadend",
          () => {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (transport) state.transport = transport;
            // writeAuditLog has no x-server-token. Keep its reusable native XHR
            // separately from the newest quota/generate credential set.
            rememberNativeXhr(xhr, request.sourcePath);
          },
          { once: true },
        );
      }
      if (isQuotaSummary(request.url) && typeof body === "string") {
        const requestText = body;
        this.addEventListener(
          "load",
          () => {
            if (this.status !== 200) return;
            try {
              observeVoiceoverAccess(requestText, this.responseText);
            } catch {
              // responseText is unavailable for non-text response types.
            }
          },
          { once: true },
        );
      }
    }
    return originalSend.call(this, body);
  };

  globalThis.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : null;
    const url = request?.url || String(input);
    const method = init?.method || request?.method || "GET";
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value: string, name: string) =>
      headers.set(name, value),
    );
    const transport = capturedTransport(method, url, headers);
    const result: Promise<Response> = Reflect.apply(
      originalFetch,
      this,
      arguments,
    );
    if (transport) {
      void result
        .then((response: Response) => {
          if (response.ok) state.transport = transport;
        })
        .catch(() => {});
    }
    if (String(method).toUpperCase() === "POST" && isQuotaSummary(url)) {
      const requestText =
        typeof init?.body === "string"
          ? Promise.resolve(init.body)
          : request
            ? request.clone().text()
            : Promise.resolve("");
      void Promise.all([
        requestText,
        result.then((response: Response) =>
          response.status === 200 ? response.clone().text() : "",
        ),
      ])
        .then(([requestBody, responseText]) => {
          if (responseText) observeVoiceoverAccess(requestBody, responseText);
        })
        .catch(() => {});
    }
    return result;
  };
});
