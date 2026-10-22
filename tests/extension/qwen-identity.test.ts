import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { detectQwenPageContext } from "../../src/extension/providers/qwen.js";

function detect(token: string, id = "owner-id", status = 200) {
  return runInNewContext(`(${detectQwenPageContext.toString()})()`, {
    __name: (value: unknown) => value,
    location: { protocol: "https:", hostname: "chat.qwen.ai" },
    localStorage: { getItem: () => token }, crypto, TextEncoder, AbortSignal,
    fetch: async (url: string, options: RequestInit) => {
      assert.equal(url, "/api/v2/auths/");
      assert.equal((options.headers as Record<string,string>).Authorization, `Bearer ${token}`);
      return Response.json({ success: status === 200, data: { id } }, { status });
    },
  });
}
test("Qwen identity survives token rotation, changes only for a different account", async () => {
  const first = await detect("private-old-token"), refreshed = await detect("private-new-token");
  assert.equal(first.accountSubject, refreshed.accountSubject);
  assert.notEqual(first.accountSubject, (await detect("private-new-token", "other-id")).accountSubject);
  assert.match(first.accountSubject, /^qwen:[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(first).includes("private-"), false);
  assert.equal(JSON.stringify(first).includes("owner-id"), false);
});
test("Qwen rejects unauthenticated or unidentified profiles instead of token identity fallback", async () => {
  await assert.rejects(detect("private-token", "owner-id", 401), /Sign in/);
  await assert.rejects(detect("private-token", ""), /account ID is unavailable/);
});
