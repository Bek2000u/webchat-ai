import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { detectGeminiPageContext } from "../../src/extension/providers/gemini.js";
import { detectQwenPageContext } from "../../src/extension/providers/qwen.js";
import { detectDeepSeekPageContext } from "../../src/extension/providers/deepseek.js";
import { detectFlowPageContext } from "../../src/extension/providers/flow/index.js";
import { detectGoogleVidsPageContext } from "../../src/extension/providers/google-vids/index.js";

for (const [id, func, host] of [
  ["gemini", detectGeminiPageContext, "gemini.google.com"],
  ["qwen", detectQwenPageContext, "chat.qwen.ai"],
  ["deepseek", detectDeepSeekPageContext, "chat.deepseek.com"],
  ["flow", detectFlowPageContext, "flow.google.com"],
  ["vids", detectGoogleVidsPageContext, "docs.google.com"],
] as const) {
  test(
    id +
      " still detects account in MAIN without reading or returning fingerprint",
    async () => {
      const secret = "isolated-token-at-least-thirty-two-characters";
      const page = {
        Symbol,
        crypto,
        TextEncoder,
        AbortController,
        AbortSignal,
        setTimeout,
        clearTimeout,
        __name: (value: unknown) => value,
        navigator: new Proxy(
          {},
          {
            get() {
              throw Error("Fingerprint must not be collected");
            },
          },
        ),
        document: {
          body: { innerText: "" },
          querySelector: () => null,
          querySelectorAll: () => [
            { getAttribute: () => "Google Account Account@Test.Example" },
          ],
        },
        location: {
          protocol: "https:",
          hostname: host,
          origin: "https://" + host,
          href: "https://" + host + "/",
          pathname: "/",
        },
        localStorage: { length: 1, key: () => "token", getItem: () => secret },
        WIZ_global_data: {
          SNlM0e: "isolated-csrf",
          eptZe: "/_/AiSandboxAngularFrontend/",
        },
        fetch: async () => id === "qwen"
          ? Response.json({ success: true, data: { id: "stable-fixture-account" } })
          : new Response('"SNlM0e":"isolated-csrf"'),
        [Symbol.for("workspaceCompanion.googleVids.transport.v1")]: {
          voiceoverAccess: {
            access: "unlimited",
            creditsTotal: 100,
            creditsRemaining: 99,
            checkedAt: "fixture",
          },
        },
      };
      const result = await runInNewContext(`(${func.toString()})(1000)`, {
        ...page,
        globalThis: page,
      });
      assert.equal("fingerprint" in result, false);
      assert.equal(JSON.stringify(result).includes(secret), false);
      if (id === "qwen" || id === "deepseek")
        assert.match(
          result.accountSubject,
          new RegExp("^" + id + ":[0-9a-f]{40}$"),
        );
      else
        assert.equal(
          (id === "flow" ? result.email : result.accountSubject).toLowerCase(),
          "account@test.example",
        );
      if (id === "vids")
        assert.equal(result.voiceoverAccess.creditsRemaining, 99);
      if (id === "flow") assert.equal(result.apiReady, true);
    },
  );
}
