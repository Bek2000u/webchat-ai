import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  installFlowRpcTransport,
  proto,
  mediaStatus,
  mediaFailure,
} from "../../../src/extension/providers/flow/rpc.js";
import {
  type FlowRpcDescriptor,
  type FlowPageState,
  type FlowMedia,
} from "../../../src/extension/providers/flow/index.js";

function pageFixture(frame: (rpc: FlowRpcDescriptor) => unknown[]) {
  let body: URLSearchParams | undefined,
    url = "",
    calls = 0;
  const key = "isolated-native-flow";
  const page = {
    Symbol,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    atob,
    __name: (value: unknown) => value,
    location: {
      origin: "https://flow.google.com",
      pathname: "/project/test",
      search: "?authuser=2",
    },
    document: { documentElement: { lang: "en" } },
    WIZ_global_data: {
      SNlM0e: "isolated-csrf",
      eptZe: "/_/AiSandboxAngularFrontend/",
      cfb2h: "fixture-build",
      FdrFJe: "fixture-session",
    },
    async fetch(input: string, init: RequestInit) {
      calls++;
      url = input;
      body = init.body as URLSearchParams;
      assert.equal(init.credentials, "include");
      const request = JSON.parse(body.get("f.req")!)[0][0],
        rpc = { id: request[0], data: JSON.parse(request[1]) };
      return new Response(")]}'\n123\n" + JSON.stringify(frame(rpc)));
    },
  };
  runInNewContext(`(${installFlowRpcTransport.toString()})(key)`, {
    ...page,
    globalThis: page,
    key,
  });
  const state = (page as unknown as Record<symbol, FlowPageState>)[
    Symbol.for(key)
  ];
  return { rpc: state.rpc!, request: () => ({ body, url, calls }) };
}
test("MAIN transport returns native data once and keeps session credentials within the page", async () => {
  const native = [["media", null, "workflow"]];
  const page = pageFixture((rpc) => [
    ["wrb.fr", "other", "[]"],
    ["wrb.fr", rpc.id, JSON.stringify(native)],
  ]);
  const result = await page.rpc({ id: "ogiZ0b", data: [1, 2] });
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), native);
  assert.equal(result.raw, undefined);
  assert.equal(
    new URL("https://flow.google.com" + page.request().url).searchParams.get(
      "authuser",
    ),
    "2",
  );
  assert.equal(page.request().body?.get("at"), "isolated-csrf");
  assert.deepEqual(JSON.parse(page.request().body!.get("f.req")!), [
    [["ogiZ0b", "[1,2]", null, "generic"]],
  ]);
  assert.equal(JSON.stringify(result).includes("isolated-csrf"), false);
  assert.equal(page.request().calls, 1);
});
test("native RPC errors preserve public reason and captcha signal without leaking arbitrary server text", async () => {
  const error = [
    7,
    "PRIVATE account/prompt",
    [
      [
        "type.googleapis.com/google.internal.labs.aisandbox.proto.common.v1.PublicAitkError",
        [49],
      ],
    ],
  ];
  const page = pageFixture((rpc) => [
    ["wrb.fr", rpc.id, null, null, null, error],
  ]);
  const result = await page.rpc({ id: "ogiZ0b", data: [] });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(
    JSON.parse(result.raw!).error.reason,
    "PUBLIC_ERROR_UNUSUAL_ACTIVITY",
  );
  assert.equal(result.raw!.includes("PRIVATE"), false);
  const captcha = pageFixture((rpc) => [
    [
      "wrb.fr",
      rpc.id,
      null,
      null,
      null,
      [7, "reCAPTCHA evaluation failed PRIVATE"],
    ],
  ]);
  assert.equal(
    JSON.parse((await captcha.rpc({ id: "ogiZ0b", data: [] })).raw!).error
      .message,
    "reCAPTCHA evaluation failed",
  );
});
test("missing/malformed matching RPC result stays unknown without a second submit", async () => {
  for (const frame of [
    () => [["wrb.fr", "other", "[]"]],
    (rpc: FlowRpcDescriptor) => [["wrb.fr", rpc.id, "{}"]],
  ]) {
    const page = pageFixture(frame),
      result = await page.rpc({ id: "ogiZ0b", data: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.submitted, true);
    assert.equal(page.request().calls, 1);
  }
});
test("native compact state 4 remains pending until an explicit terminal failure appears", () => {
  const media = (fields: unknown[]) =>
    proto({ 1: "media", 6: proto({ 9: fields }) }) as FlowMedia;
  const pending = media([4, []]);
  assert.equal(mediaStatus(pending), 1);
  assert.equal(mediaFailure(pending), undefined);
  const failed = media([4, [7, "PRIVATE"]]);
  assert.equal(mediaStatus(failed), 4);
  assert.equal(mediaFailure(failed)?.status, "PERMISSION_DENIED");
  assert.equal(JSON.stringify(mediaFailure(failed)).includes("PRIVATE"), false);
  assert.equal(mediaStatus(media([4, [], true])), 4);
});
