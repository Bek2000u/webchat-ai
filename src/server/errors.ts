import { z } from "zod";
import { formatRequestError, type RequestError, type RequestAttempt, type RequestRecord } from "../shared/contracts.js";

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
    readonly param: string | null = null,
    readonly details?: Partial<RequestError> & { request_id: string; attempts: RequestAttempt[] },
  ) {
    super(message);
  }
}

export function requestServiceError(record: RequestRecord) {
  const error = record.error!, code = error.code.toLowerCase();
  const status = /cancelled/.test(code) ? 499
    : /queue_timeout|extension_timeout/.test(code) ? 504
    : /invalid_parameters|request_invalid|unsupported|thinking_unavailable/.test(code) ? 400
    : /capacity|rate.?limit|quota/.test(code) ? 429
    : error.outcome === "unknown" || code === "outcome_unknown" || /unavailable|busy|sign_in_required|account_changed|auth_rejected/.test(code) ? 503 : 502;
  return new ServiceError(formatRequestError(error), status, error.code, null, {
    ...error, request_id: record.id, attempts: record.attempts,
  });
}

export function apiError(error: unknown) {
  const known = error instanceof ServiceError;
  const status = known
    ? error.status
    : error instanceof z.ZodError || error instanceof SyntaxError
      ? 400
      : 500;
  return {
    status,
    body: {
      error: {
        message: known
          ? error.message
          : error instanceof z.ZodError
            ? (error.issues[0]?.message ?? "Invalid request")
            : error instanceof SyntaxError
              ? "Invalid JSON"
              : "Internal server error",
        type:
          status === 401
            ? "authentication_error"
            : status === 429
              ? "rate_limit_error"
              : status < 500
                ? "invalid_request_error"
                : "server_error",
        code: known
          ? error.code
          : status === 400
            ? "invalid_request"
            : "server_error",
        param: error instanceof ServiceError ? error.param : null,
        ...(known && error.details ? {
          provider: error.details.provider, stage: error.details.stage,
          retryable: error.details.retryable, outcome: error.details.outcome,
          request_id: error.details.request_id, attempts: error.details.attempts,
        } : {}),
      },
    },
  };
}
