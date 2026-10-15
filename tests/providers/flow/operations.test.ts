import assert from "node:assert/strict";
import test from "node:test";
import { FlowService, resolveModel } from "../../../src/extension/providers/flow/operations.js";
import { proto } from "../../../src/extension/providers/flow/rpc.js";
import {
  type FlowPageResponse,
  type FlowRpcDescriptor,
  type FlowMedia,
} from "../../../src/extension/providers/flow/index.js";
import { type ProviderContext } from "../../../src/extension/runtime/runtime.js";

const ok = (data: unknown[]): FlowPageResponse => ({
  ok: true,
  status: 200,
  submitted: true,
  data,
});
const context = (): ProviderContext => ({
  requestId: "test-request",
  accountSubject: "isolated@example.test",
  signal: new AbortController().signal,
});
const media = (
  name: string,
  seed?: unknown,
  kind = "image",
  status = 3,
  url?: string,
): FlowMedia =>
  proto({
    1: name,
    3: "workflow",
    6: proto({ 9: [status] }),
    [kind === "image" ? 7 : 8]: [
      proto({
        2: seed,
        [kind === "image" ? 14 : 9]:
          url ??
          (status === 3
            ? "https://example.googleusercontent.com/" + name
            : undefined),
      }),
    ],
  }) as FlowMedia;
function fixture(handler: (rpc: FlowRpcDescriptor) => FlowPageResponse) {
  const calls: FlowRpcDescriptor[] = [];
  const service = new FlowService({
    verifyAccount: async () => {},
    executeCaptcha: async () => "fake-site-token",
    sleep: async () => {},
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      }),
    requestRpc: async (rpc) => {
      calls.push(rpc);
      if (rpc.id === "jHPbke") return ok(["projects/isolated-project"]);
      return handler(rpc);
    },
  });
  return { service, calls };
}
const requests = (rpc: FlowRpcDescriptor, index = 1) =>
  rpc.data[index] as unknown[][];
const image = (
  value: string,
  role: "reference" | "start_frame" | "end_frame" = "reference",
) => ({
  type: "image" as const,
  source: { type: "url" as const, value },
  metadata: { role },
});
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test("an explicit single-image capacity rejection permits failover, but missing receipts and batches do not", async () => {
  for (const count of [1, 2]) {
    const { service, calls } = fixture(() => ({ ok: false, status: 429, submitted: true, raw: "PUBLIC_ERROR_HIGH_TRAFFIC" }));
    await assert.rejects(service.generateImages({ model: "nano-banana-2.1", prompt: "test", numberOfImages: count }, context()), {
      code: "FLOW_CAPACITY", outcome: count === 1 ? "not_submitted" : "unknown", retryable: count === 1 ? true : undefined,
    });
    assert.equal(calls.filter(call => call.id === "ogiZ0b").length, 1);
  }
});

test("image upscale waits for a confirmed base and host permission before submitting SPrCad", async () => {
  for (const accepted of [false, true]) {
    let ready = 0;
    const { service, calls } = fixture((rpc) => rpc.id === "ogiZ0b" ? ok([[media("base", requests(rpc)[0][3])]]) : ok([null, "encoded"]));
    const promise = service.generateImages({ model: "nano-banana-2-lite", prompt: "Fixture", size: "2k" }, {
      ...context(), upscaleReady: async () => { ready++; return accepted; },
    });
    if (accepted) await promise; else await assert.rejects(promise, { code: "UPSCALE_WINDOW_EXPIRED" });
    assert.equal(ready, 1);
    assert.equal(calls.filter(call => call.id === "SPrCad").length, Number(accepted));
  }
});

test("native image batch keeps distinct prompts/references, exact protobuf fields and seed order", async () => {
  let uploads = 0;
  const { service, calls } = fixture((rpc) => {
    if (rpc.id === "maseQ") return ok([media("uploaded-" + ++uploads)]);
    assert.equal(rpc.id, "ogiZ0b");
    return ok([
      requests(rpc)
        .map((row, index) => media("output-" + index, row[3]))
        .reverse(),
    ]);
  });
  const result = await service.generateImages(
    {
      model: "nano-banana-2.1",
      prompt: "unused",
      numberOfImages: 2,
      modelOptions: {
        batch: [
          {
            seed: 11,
            prompt: [
              { type: "text", content: "First" },
              image("https://input.test/one"),
            ],
          },
          {
            seed: 22,
            prompt: [
              { type: "text", content: "Second" },
              image("https://input.test/two"),
            ],
          },
        ],
      },
    },
    context(),
  );
  const submitted = calls.filter((rpc) => rpc.id === "ogiZ0b");
  assert.equal(submitted.length, 1);
  const data = json(submitted[0].data) as unknown[][],
    rows = data[1] as unknown[][];
  const expectedContext = [
    null,
    22,
    null,
    null,
    null,
    "isolated-project",
    null,
    null,
    null,
    null,
    ["fake-site-token", 1],
  ];
  assert.deepEqual(data[3], expectedContext);
  assert.equal(data[2], 1);
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.slice(0, 12), [
      null,
      null,
      [["uploaded-" + (index + 1), null, null, null, 1]],
      index ? 22 : 11,
      3,
      "BELUGA",
      null,
      expectedContext,
      [[[index ? "Second" : "First"]]],
      null,
      null,
      null,
    ]);
    assert.equal(typeof row[12], "string");
    assert.equal(typeof row[13], "string");
  }
  assert.deepEqual(result.images, [
    { url: "https://example.googleusercontent.com/output-0" },
    { url: "https://example.googleusercontent.com/output-1" },
  ]);
});
test("numberOfImages creates requested items; a repeated reference uploads once and incomplete batch never resubmits", async () => {
  let uploads = 0;
  const { service, calls } = fixture((rpc) =>
    rpc.id === "maseQ"
      ? (uploads++, ok([media("reference")]))
      : ok([requests(rpc).map((row, index) => media("out-" + index, row[3]))]),
  );
  const result = await service.generateImages(
    {
      model: "nano-banana-2.1",
      prompt: [
        { type: "text", content: "Three" },
        image("https://input.test/same"),
      ],
      numberOfImages: 3,
    },
    context(),
  );
  assert.equal(result.images.length, 3);
  assert.equal(uploads, 1);
  assert.equal(calls.filter((rpc) => rpc.id === "ogiZ0b").length, 1);
  const incomplete = fixture(() => ok([[]]));
  await assert.rejects(
    incomplete.service.generateImages(
      { model: "nano-banana-2.1", prompt: "One" },
      context(),
    ),
    { code: "outcome_unknown" },
  );
  assert.equal(incomplete.calls.filter((rpc) => rpc.id === "ogiZ0b").length, 1);
});
test("ambiguous submit and explicit captcha rejection have no retries", async () => {
  for (const response of [
    { ok: false, status: 0, submitted: true, error: "Lost response" },
    {
      ok: false,
      status: 403,
      submitted: false,
      raw: "reCAPTCHA evaluation failed",
    },
  ]) {
    const { service, calls } = fixture(() => response);
    await assert.rejects(
      service.generateImages(
        { model: "nano-banana-2.1", prompt: "One" },
        context(),
      ),
    );
    assert.equal(calls.filter((rpc) => rpc.id === "ogiZ0b").length, 1);
  }
});
test("native start/end video retains crop, duration, audio, polling and one upscale stage", async () => {
  let upscaleReady = 0;
  let uploads = 0;
  const { service, calls } = fixture((rpc) => {
    if (rpc.id === "nzlxg") return ok([100, 2]);
    if (rpc.id === "maseQ") return ok([media("uploaded-" + ++uploads)]);
    if (rpc.id === "jwpduf") {
      const name = (rpc.data[2] as string[][])[0][0];
      return ok([null, null, [media(name, 0, "video")]]);
    }
    if (rpc.id === "nprQif" || rpc.id === "p0UkFb")
      return ok([
        null,
        null,
        null,
        [
          media(
            rpc.id === "nprQif" ? "video-operation" : "upscale-operation",
            0,
            "video",
            1,
          ),
        ],
      ]);
    throw Error("Unexpected RPC " + rpc.id);
  });
  const result = await service.generateVideo(
    {
      model: "gemini-omni-flash-preview",
      prompt: [
        { type: "text", content: "Animate" },
        image("https://input.test/end", "end_frame"),
        image("https://input.test/start", "start_frame"),
      ],
      size: "1080p",
      duration: 6,
      modelOptions: { aspect_ratio: "9:16", with_audio: true, seed: 42 },
    },
    { ...context(), upscaleReady: async () => {
      upscaleReady++;
      assert.equal(calls.at(-1)?.id, "jwpduf");
      assert.equal(calls.filter(call => call.id === "p0UkFb").length, 0);
      return true;
    } },
  );
  assert.equal(upscaleReady, 1);
  assert.equal(
    result.url,
    "https://example.googleusercontent.com/upscale-operation",
  );
  const generation = calls.filter((rpc) => rpc.id === "nprQif");
  assert.equal(generation.length, 1);
  const row = requests(generation[0], 0)[0];
  assert.match(String(row[1]), /6s_first_last/);
  assert.equal(row[2], 1);
  assert.equal(row[3], 42);
  assert.deepEqual(json(row[4]), [
    null,
    "uploaded-1",
    null,
    null,
    null,
    [null, null, 1, 1],
  ]);
  assert.deepEqual(json(row[5]), [
    null,
    "uploaded-2",
    null,
    null,
    null,
    [null, null, 1, 1],
  ]);
  assert.equal((generation[0].data[2] as unknown[])[1], 1);
  assert.deepEqual(
    calls
      .filter((rpc) => rpc.id === "jwpduf")
      .map((rpc) => (rpc.data[2] as string[][])[0][0]),
    ["video-operation", "upscale-operation"],
  );
  const upscale = calls.filter((rpc) => rpc.id === "p0UkFb");
  assert.equal(upscale.length, 1);
  const upscaleRow = requests(upscale[0], 0)[0];
  assert.deepEqual(upscaleRow[0], [null, "video-operation"]);
  assert.equal(upscaleRow[6], 2);
  assert.match(String(upscaleRow[31]), /upsampler/);
});
for (const [mode, id] of [
  ["text", "YhhmEf"],
  ["start", "eb1hJf"],
  ["reference", "MZZa6b"],
] as const) {
  test(
    "native video " + mode + " route preserves its field positions",
    async () => {
      const { service, calls } = fixture((rpc) => {
        if (rpc.id === "nzlxg") return ok([100, 1]);
        if (rpc.id === "maseQ") return ok([media("reference")]);
        assert.equal(rpc.id, id);
        return ok([null, null, null, [media("video", 12, "video")]]);
      });
      const result = await service.generateVideo(
        {
          model: "veo-3.1-fast-generate-preview",
          prompt:
            mode === "text"
              ? "Animate"
              : [
                  { type: "text", content: "Animate" },
                  image(
                    "https://input.test/start",
                    mode === "start" ? "start_frame" : "reference",
                  ),
                ],
          duration: 8,
          size: "720p",
          modelOptions: { seed: 12 },
        },
        context(),
      );
      assert.equal(result.url, "https://example.googleusercontent.com/video");
      const generation = calls.find((rpc) => rpc.id === id)!,
        row = requests(generation, 0)[0];
      assert.deepEqual(json(row[0]), [null, null, [[["Animate"]]]]);
      assert.equal(row[mode === "reference" ? 4 : 3], 12);
      assert.deepEqual(
        row[mode === "text" ? 7 : mode === "start" ? 9 : 11],
        [1],
      );
      if (mode === "reference") assert.deepEqual(row[1], [[null, "reference"]]);
      assert.equal(calls.filter((rpc) => rpc.id === "jwpduf").length, 0);
    },
  );
}
test("poll failure never creates another generation or changes the polled operation", async () => {
  const { service, calls } = fixture((rpc) =>
    rpc.id === "nzlxg"
      ? ok([100, 1])
      : rpc.id === "YhhmEf"
        ? ok([null, null, null, [media("one-operation", 0, "video", 1)]])
        : { ok: false, status: 502, submitted: true },
  );
  await assert.rejects(
    service.generateVideo(
      {
        model: "veo-3.1-fast-generate-preview",
        prompt: "Video",
        size: "720p",
        duration: 8,
      },
      context(),
    ),
  );
  assert.equal(calls.filter((rpc) => rpc.id === "YhhmEf").length, 1);
  assert.deepEqual(calls.find((rpc) => rpc.id === "jwpduf")?.data, [
    null,
    null,
    [["one-operation"]],
  ]);
});
test("image upscale keeps native resolution and paygate tier and returns real base64", async () => {
  const { service, calls } = fixture((rpc) =>
    rpc.id === "nzlxg"
      ? ok([100, 2])
      : rpc.id === "ogiZ0b"
        ? ok([[media("base-image")]])
        : ok([null, "AQID"]),
  );
  const result = await service.generateImages(
    { model: "gemini-3.0-pro-image", prompt: "Upscale", size: "2k" },
    context(),
  );
  assert.deepEqual(result.images, [{ b64Json: "AQID" }]);
  const upscale = calls.find((rpc) => rpc.id === "SPrCad")!;
  assert.equal(upscale.data[0], "base-image");
  assert.equal(upscale.data[1], 1);
  assert.equal((upscale.data[2] as unknown[])[6], 2);
  assert.equal(calls.filter((rpc) => rpc.id === "SPrCad").length, 1);
});
test("native media download retains embedded bytes and content type", async () => {
  const { service, calls } = fixture((rpc) => {
    assert.equal(rpc.id, "as29s");
    return ok(proto({ 1: "video", 8: [["AQID"]] }));
  });
  const result = await service.fetchArtifact(
    "provider-artifact://video",
    new AbortController().signal,
  );
  assert.deepEqual(result.body, new Uint8Array([1, 2, 3]));
  assert.equal(result.mimeType, "video/mp4");
  assert.deepEqual(calls[0].data, ["video"]);
});
test("model options retain economy upscale, low priority and early 4K plan checks", async () => {
  const relaxed = resolveModel("veo-3.1-fast-generate-preview", "video", {
    priority: "low_priority",
  });
  assert.match(relaxed.key, /_relaxed$/);
  const economy = resolveModel("gemini-omni-flash-preview", "video", {
    size: "720p_economy",
    duration: 6,
  });
  assert.equal(economy.mediaKind, "video");
  if (economy.mediaKind === "video") {
    assert.equal(economy.generationResolution, 4);
    assert.equal(economy.upsampleResolution, 1);
  }
  const { service, calls } = fixture(() => ok([100, 1]));
  await assert.rejects(
    service.generateImages(
      { model: "gemini-3.0-pro-image", prompt: "Ultra", size: "4k" },
      context(),
    ),
    { code: "FLOW_ULTRA_REQUIRED" },
  );
  assert.equal(
    calls.some((rpc) => rpc.id === "ogiZ0b"),
    false,
  );
});
