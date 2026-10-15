/** Browser retry policy, shared by the driver boundary and dispatcher.
 * A fresh attempt may spend account quota again; it is not receipt recovery.
 */
export function accountError(code: string) {
  return /SIGN_IN_REQUIRED|ACCOUNT_CHANGED|ACCOUNT_THROTTLED|AUTH_REJECTED|MODEL_ACCESS_DENIED|SESSION_HEAT|QUOTA|CREDITS|CAPTCHA_REJECTED|PROFILE_REJECTED|THINKING_UNAVAILABLE/.test(
    code.toUpperCase(),
  );
}

export function invalidTextError(code: string) {
  return /^(INVALID_STRUCTURED_OUTPUT|INVALID_PROVIDER_RESPONSE|LLM_TRANSIENT_RESPONSE)$|_RESPONSE_INVALID$/.test(
    code.toUpperCase(),
  );
}

export function transientProviderError(code: string) {
  return (
    accountError(code) ||
    invalidTextError(code) ||
    /^(OUTCOME_UNKNOWN|NETWORK_ERROR|GENERATION_FAILED|FLOW_CAPACITY|PROVIDER_(UNAVAILABLE|BUSY|PAGE_UNAVAILABLE)|EXTENSION_(DISCONNECTED|UNAVAILABLE|TIMEOUT)|SESSION_CONFLICT|BROWSER_CONTEXT_LOST|BROWSER_DISCONNECTED|UPSTREAM_(408|409|425|429|500|502|503|504))$|_UI_NOT_READY$|_UI_ERROR$|_RESPONSE_TIMEOUT$|_PROMPT_MISMATCH$/.test(
      code.toUpperCase(),
    )
  );
}
import type { RequestError, ProviderId } from "./contracts.js";

export function normalizeProviderError(caught: unknown, context: { provider: ProviderId; stage?: string; aborted?: boolean }): RequestError {
  const error = caught && typeof caught === "object" ? caught as Record<string, unknown> : {};
  const stage = typeof error.stage === "string" && error.stage ? error.stage : context.stage;
  const code = context.aborted ? "outcome_unknown" : typeof error.code === "string" && error.code ? error.code : "PROVIDER_ERROR";
  const outcome = context.aborted || code === "outcome_unknown" ? "unknown"
    : ["not_submitted", "failed", "unknown"].includes(String(error.outcome)) ? error.outcome as RequestError["outcome"]
    : error.submitted === false || stage === "account" || stage === "prepare" ? "not_submitted" : "unknown";
  return { code, message: providerMessage(error.message), provider: context.provider, outcome,
    retryable: !context.aborted && stage !== "result_upload" && (typeof error.retryable === "boolean" ? error.retryable : transientProviderError(code)),
    ...(stage ? { stage } : {}),
  };
}

export function providerMessage(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /<!doctype|<html|^\s*[\[{]/i.test(value)
  )
    return "Provider request failed; check its browser tab";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(
      /Bearer\s+\S+|\bsk-[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi,
      "[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

const temporaryText = new Set([
  "something went wrong. please try again.",
  "sorry, something went wrong. please try your request again.",
  "i encountered an error doing what you asked. could you try again?",
  "i seem to be encountering an error. can i try something else for you?",
  "i'm having a hard time fulfilling your request. can i help you with something else instead?",
]);

export function textResultError(
  result: unknown,
  structured: boolean,
): RequestError | undefined {
  const text =
    result && typeof result === "object" && "text" in result
      ? result.text
      : undefined;
  let code: string | undefined,
    message = "";
  if (typeof text !== "string" || !text.trim()) {
    code = "INVALID_PROVIDER_RESPONSE";
    message = "Provider returned no completed text";
  } else if (
    temporaryText.has(text.trim().replace(/\s+/g, " ").toLowerCase())
  ) {
    code = "LLM_TRANSIENT_RESPONSE";
    message =
      "Provider returned a temporary error message instead of an answer";
  } else if (structured) {
    try {
      JSON.parse(text);
    } catch {
      code = "INVALID_STRUCTURED_OUTPUT";
      message = "Provider returned invalid structured JSON";
    }
  }
  return code
    ? { code, message, stage: "result", outcome: "failed", retryable: true }
    : undefined;
}
