import assert from "node:assert/strict";
import test from "node:test";
import { toRequestError } from "../../src/extension/runtime/runtime.js";
import { requestErrorSchema, formatRequestError } from "../../src/shared/contracts.js";
import { providerMessage, textResultError } from "../../src/shared/errors.js";

test("common error boundary preserves provider code, cause message and UI stage only", () => {
  const error = toRequestError(Object.assign(Error("Сервер временно недоступен."), {
    code: "DEEPSEEK_UI_ERROR", stage: "response", details: { token: "private" }, headers: { Authorization: "private" },
  }), { provider: "deepseek_web", stage: "execute" });
  assert.deepEqual(error, { code: "DEEPSEEK_UI_ERROR", message: "Сервер временно недоступен.", provider: "deepseek_web", stage: "response", outcome: "unknown", retryable: true });
  assert.deepEqual(requestErrorSchema.parse({ id: "request", error }).error, error);
  assert.equal(formatRequestError(error), "DeepSeek Web / response — DEEPSEEK_UI_ERROR: Сервер временно недоступен.");
  assert.ok(!JSON.stringify(error).includes("private"));
});
test("unknown and aborted failures keep the same contract without inventing a provider rejection", () => {
  assert.equal(toRequestError(null, { provider: "qwen_web" }).code, "PROVIDER_ERROR");
  assert.equal(toRequestError(Error("Cancelled"), { provider: "qwen_web", aborted: true }).code, "outcome_unknown");
});

test("unknown permits one fresh attempt but abort and artifact collection never regenerate", () => {
  for (const context of [{ provider: "flow" as const }, { provider: "flow" as const, aborted: true }]) {
    const error = toRequestError(Object.assign(Error("Lost receipt"), { code: "outcome_unknown", outcome: "not_submitted", retryable: true }), context);
    assert.equal(error.outcome, "unknown");
    assert.equal(error.retryable, !context.aborted);
  }
  const safe = toRequestError(Object.assign(Error("Refused"), { code: "CAPACITY", outcome: "not_submitted", retryable: true }), { provider: "flow" });
  assert.equal(safe.retryable, true);
  assert.equal(safe.outcome, "not_submitted");
  assert.equal(toRequestError(Object.assign(Error("Upload failed"), { retryable: true }), { provider: "flow", stage: "result_upload" }).retryable, false);
});

test("provider messages stay bounded and do not expose raw HTML, JSON or bearer values", () => {
  assert.equal(providerMessage("x".repeat(1000)).length, 600);
  assert.ok(!providerMessage("Failed Bearer secret-value").includes("secret-value"));
  for (const message of ["<html>vendor debug</html>", '{"token":"secret-value"}'])
    assert.equal(providerMessage(message), "Provider request failed; check its browser tab");
  assert.equal(textResultError({ text: "Something went wrong. Please try again." }, false)?.code, "LLM_TRANSIENT_RESPONSE");
  assert.equal(textResultError({ text: 'The phrase "Something went wrong" is an error message.' }, false), undefined);
});
