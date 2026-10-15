import {
  type FlowRpcDescriptor,
  type FlowRpcGlobal,
  type FlowPageState,
  type FlowPageResponse,
  type FlowMedia,
} from "./index.js";

interface DecodedRpcError {
  status: number;
  error: { code: number; status: string; message: string; reason?: string };
}
/** Native protobuf JSON: field N is array index N-1. */
export function proto(fields: Record<number, unknown>): unknown[] {
  const result: unknown[] = [];
  for (const [field, value] of Object.entries(fields))
    if (value !== undefined && value !== null)
      result[Number(field) - 1] = value;
  return result;
}
const decodeFlowError = installFlowRpcTransport();
export function mediaLink(row: FlowMedia): string | undefined {
  return (
    row[6]?.[0]?.[13] ||
    row[6]?.[1]?.[3] ||
    row[7]?.[0]?.[8] ||
    row[7]?.[4]?.[2]
  );
}
export function mediaStatus(row: FlowMedia): number {
  const fields = row[5]?.[8],
    status = fields?.[0],
    failure = fields?.[1];
  if (
    status === 4 &&
    !(
      (Array.isArray(failure) &&
        Number.isInteger(failure[0]) &&
        failure[0] !== 0) ||
      Boolean(failure && decodeFlowError(failure).error.reason) ||
      (fields!.length > 2 && fields![2] != null)
    )
  )
    return 1;
  return status || (mediaLink(row) ? 3 : 1);
}
export function mediaFailure(row: FlowMedia) {
  const failure = row[5]?.[8]?.[1];
  return failure && (row[5]?.[8]?.[0] !== 4 || mediaStatus(row) === 4)
    ? decodeFlowError(failure).error
    : undefined;
}
// Installed in the page world. The CSRF value and browser session never cross
// into the extension worker, host or diagnostic reports.
export function installFlowRpcTransport(): (value: unknown) => DecodedRpcError;
export function installFlowRpcTransport(stateKey: string): void;
export function installFlowRpcTransport(stateKey?: string) {
  // This function is injected into MAIN in isolation. Decode only public
  // status/reason fields here; Any metadata and session data stay in Chrome.
  const statuses: Record<number, [number, string]> = {
    1: [499, "CANCELLED"],
    2: [500, "UNKNOWN"],
    3: [400, "INVALID_ARGUMENT"],
    4: [504, "DEADLINE_EXCEEDED"],
    5: [404, "NOT_FOUND"],
    6: [409, "ALREADY_EXISTS"],
    7: [403, "PERMISSION_DENIED"],
    8: [429, "RESOURCE_EXHAUSTED"],
    9: [400, "FAILED_PRECONDITION"],
    10: [409, "ABORTED"],
    11: [400, "OUT_OF_RANGE"],
    12: [501, "UNIMPLEMENTED"],
    13: [500, "INTERNAL"],
    14: [503, "UNAVAILABLE"],
    15: [500, "DATA_LOSS"],
    16: [401, "UNAUTHENTICATED"],
  };
  // PublicAitkError field 1, as declared by the captured Flow frontend.
  const publicErrors: Record<number, string> = {
    0: "UNSPECIFIED",
    1: "UNSAFE_GENERATION",
    2: "USER_QUOTA_REACHED",
    3: "USER_REQUESTS_THROTTLED",
    4: "HIGH_TRAFFIC",
    5: "MODEL_DISABLED_DUE_TO_TRAFFIC",
    7: "NON_ENGLISH_PROMPT",
    8: "UNSAFE_IMAGE_UPLOAD",
    9: "GENERATION_ALREADY_IN_PROGRESS",
    11: "MODEL_ACCESS_DENIED",
    12: "PROMINENT_PEOPLE_FILTER_FAILED",
    14: "VIOLENCE_FILTER",
    15: "DANGER_FILTER",
    16: "SEXUAL",
    17: "MINOR_UPLOAD",
    18: "SEXUAL_UPLOAD",
    19: "PROMINENT_PEOPLE_UPLOAD",
    20: "PHOTOREAL_UPLOAD",
    21: "MINOR",
    22: "MINOR_HARM_UPLOAD",
    23: "PHOTOREAL_INPUT_IMAGE",
    24: "PROMINENT_PEOPLE_INPUT_IMAGE",
    25: "MINOR_INPUT_IMAGE",
    26: "UNKNOWN_IMAGE_FILE_FORMAT",
    27: "VIDEO_GENERATION_TIMED_OUT",
    28: "MODEL_OVERLOADED",
    29: "HANDLE_INVALID",
    30: "HANDLE_TAKEN",
    31: "IMAGE_TOO_LARGE",
    32: "PER_MODEL_DAILY_QUOTA_REACHED",
    33: "AUDIO_FILTERED",
    34: "PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE",
    35: "SOMETHING_WENT_WRONG",
    36: "COLLECTION_INVALID",
    39: "COLLECTION_FULL",
    40: "COLLECTION_DEPTH_EXCEEDED",
    41: "IP_INPUT_IMAGE",
    42: "APP_UNAVAILABLE",
    44: "IMAGE_TOO_SMALL",
    45: "USER_REGION_DISALLOWED",
    46: "USER_MINOR",
    47: "IMAGE_OUTPUT_IP_FILTER",
    48: "WORKSPACE_ACCOUNT_QUOTA_REACHED",
    49: "UNUSUAL_ACTIVITY",
    50: "UNUSUAL_ACTIVITY_TOO_MUCH_TRAFFIC",
    51: "CONCURRENT_LIMIT_REACHED",
    52: "MEDIA_GENERATION_CANNOT_BE_CANCELED",
    53: "UNSAFE_VIDEO_UPLOAD",
    54: "VIDEO_UPLOAD_TIMEOUT",
    55: "VIDEO_DURATION_TOO_LONG",
    56: "APPLET_SIZE_LIMIT_EXCEEDED",
    57: "APPLET_STORAGE_QUOTA_EXCEEDED",
    58: "VIDEO_UPLOAD_FAILED",
    59: "SPEECH_EDIT",
    60: "VIDEO_EDIT",
    61: "REPUTATIONAL",
    63: "UNDERSPECIFIED_ANIMAL",
    64: "RESPONSE_TOO_LONG",
    65: "PROJECT_NOT_ALLOWLISTED",
    66: "USER_ROLE_NOT_GRANTED",
    67: "PROJECT_FLOW_ENTERPRISE_NOT_ENABLED",
    68: "VERTEX_SAFETY_FILTER_TRIGGERED",
    69: "VERTEX_UNSUPPORTED_INPUT",
    70: "VERTEX_QUOTA_EXHAUSTED",
    71: "VERTEX_QUOTA_EXHAUSTED_ADMIN",
    72: "VERTEX_SERVICE_UNAVAILABLE",
  };
  function firstField(value: unknown): unknown {
    if (Array.isArray(value)) return value[0];
    // Any may contain a proto-array or base64 protobuf bytes. Only field 1
    // (ErrorInfo.reason / PublicAitkError enum) is needed, never its metadata.
    if (typeof value !== "string" || value.length > 16384) return undefined;
    try {
      const bytes = Uint8Array.from(
        atob(value.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      let offset = 0;
      const integer = () => {
        let result = 0;
        for (let shift = 0; shift < 35 && offset < bytes.length; shift += 7) {
          const byte = bytes[offset++];
          result += (byte & 127) * 2 ** shift;
          if (!(byte & 128)) return result;
        }
        throw new Error("Invalid protobuf integer");
      };
      while (offset < bytes.length) {
        const tag = integer(),
          field = Math.floor(tag / 8),
          wire = tag % 8;
        if (!field) return undefined;
        if (wire === 0) {
          const number = integer();
          if (field === 1) return number;
        } else if (wire === 2) {
          const size = integer(),
            end = offset + size;
          if (end > bytes.length) return undefined;
          if (field === 1)
            return new TextDecoder().decode(bytes.subarray(offset, end));
          offset = end;
        } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
        else return undefined;
      }
    } catch {
      /* Unknown/malformed details must not hide the outer status. */
    }
    return undefined;
  }
  function publicReason(error: unknown[]) {
    if (
      typeof error[1] === "string" &&
      /^PUBLIC_ERROR_[A-Z0-9_]{1,100}$/.test(error[1])
    )
      return error[1];
    const details = Array.isArray(error[2]) ? error[2].slice(0, 32) : [];
    for (const detail of details) {
      if (!Array.isArray(detail) || typeof detail[0] !== "string") continue;
      const type = detail[0].split("/").pop();
      if (
        type !== "google.rpc.ErrorInfo" &&
        type !==
          "google.internal.labs.aisandbox.proto.common.v1.PublicAitkError"
      )
        continue;
      const value = firstField(detail[1]);
      if (
        type === "google.rpc.ErrorInfo" &&
        typeof value === "string" &&
        /^PUBLIC_ERROR_[A-Z0-9_]{1,100}$/.test(value)
      )
        return value;
      if (
        type?.endsWith("PublicAitkError") &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        publicErrors[value]
      ) {
        return `PUBLIC_ERROR_${publicErrors[value]}`;
      }
    }
    return undefined;
  }
  function decodeError(value: unknown): DecodedRpcError {
    const error = Array.isArray(value) ? value : [];
    const code =
      typeof error[0] === "number" && Number.isInteger(error[0]) ? error[0] : 2;
    const [status, name] = statuses[code] || [500, "UNKNOWN"];
    const reason = publicReason(error);
    // Keep the token-rejection signal, never arbitrary server messages which
    // can echo prompts or account data. Media failures use this policy too.
    const message = /recaptcha evaluation failed/i.test(String(error[1] || ""))
      ? "reCAPTCHA evaluation failed"
      : `Google Flow RPC failed (${name}${reason ? `: ${reason}` : ""})`;
    return {
      status,
      error: { code, status: name, message, ...(reason ? { reason } : {}) },
    };
  }
  if (stateKey === undefined) return decodeError;
  const key = Symbol.for(stateKey);
  const state: FlowPageState = (globalThis as FlowRpcGlobal)[key] || {
    controllers: new Map(),
  };
  if (!Number.isSafeInteger(state.nextReqid)) {
    state.nextReqid = Math.floor(Math.random() * 90000) + 10000;
  }
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  state.rpc = async (rpc: FlowRpcDescriptor, signal?: AbortSignal) => {
    if (location.origin !== "https://flow.google.com") {
      return {
        ok: false,
        status: 0,
        submitted: false,
        context_code: "FLOW_PAGE_API_MISSING",
        error: "Google Flow tab changed before the request",
      };
    }
    const config = (globalThis as FlowRpcGlobal).WIZ_global_data;
    if (!config?.SNlM0e || config.eptZe !== "/_/AiSandboxAngularFrontend/") {
      return {
        ok: false,
        status: 0,
        submitted: false,
        context_code: "FLOW_RPC_CONTEXT_MISSING",
        error: "Google Flow session is not ready",
      };
    }
    const query = new URLSearchParams({
      rpcids: rpc.id,
      rt: "c",
      "source-path": location.pathname,
      hl: document.documentElement.lang || "en",
    });
    query.set("_reqid", String(state.nextReqid!));
    state.nextReqid! += 100000;
    if (config.cfb2h) query.set("bl", config.cfb2h);
    if (config.FdrFJe) query.set("f.sid", config.FdrFJe);
    const authuser = new URLSearchParams(location.search).get("authuser");
    if (authuser && /^\d+$/.test(authuser)) query.set("authuser", authuser);
    const response = await fetch(`${config.eptZe}data/batchexecute?${query}`, {
      method: "POST",
      credentials: "include",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: new URLSearchParams({
        at: config.SNlM0e,
        "f.req": JSON.stringify([
          [[rpc.id, JSON.stringify(rpc.data), null, "generic"]],
        ]),
      }),
      signal,
    });
    if (!response.ok)
      return { ok: false, status: response.status, submitted: true, raw: "" };
    const text = await response.text();
    // batchexecute frames contain a byte-count line followed by a JSON line;
    // only the matching response is relevant, never another RPC in the batch.
    for (const line of text.split("\n")) {
      if (!line.startsWith("[")) continue;
      let rows;
      try {
        rows = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row?.[0] !== "wrb.fr" || row[1] !== rpc.id) continue;
        if (typeof row[2] === "string") {
          try {
            const data = JSON.parse(row[2]);
            if (Array.isArray(data))
              return { ok: true, status: 200, submitted: true, data };
          } catch {
            /* Missing acknowledgement must retain the submit receipt. */
          }
        }
        const error = row[5];
        if (
          Array.isArray(error) &&
          Number.isInteger(error[0]) &&
          error[0] !== 0
        ) {
          const decoded = decodeError(error);
          return {
            ok: false,
            status: decoded.status,
            submitted: true,
            raw: JSON.stringify({ error: decoded.error }),
          };
        }
      }
    }
    return {
      ok: false,
      status: 0,
      submitted: true,
      context_code: "FLOW_REQUEST_OUTCOME_UNKNOWN",
      error: "Google Flow returned no matching RPC acknowledgement",
    };
  };
}
