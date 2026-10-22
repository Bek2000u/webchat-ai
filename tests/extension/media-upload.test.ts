import assert from "node:assert/strict";
import test from "node:test";
import { uploadResult } from "../../src/extension/runtime/media.js";
import { type ProviderAdapter } from "../../src/extension/runtime/runtime.js";
import { type SDKResult } from "../../src/shared/contracts.js";

for (const kind of ["image", "audio", "video"] as const) {
  test(`${kind} uploads a Blob, not a Chromium-incompatible streaming HTTP/1 body`, async (t) => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const controller = new AbortController();
    let downloads = 0;
    let uploads = 0;
    const provider = {
      id: "flow",
      async fetchArtifact() {
        downloads++;
        return {
          body: new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(bytes);
              stream.close();
            },
          }),
          mimeType: "application/octet-stream",
        };
      },
    } as unknown as ProviderAdapter;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      uploads++;
      assert.equal(url, "http://127.0.0.1:8001/api/browser/files");
      assert.ok(init?.body instanceof Blob);
      assert.equal("duplex" in init, false);
      assert.deepEqual(new Uint8Array(await init.body.arrayBuffer()), bytes);
      return Response.json({ id: "test", url: "http://127.0.0.1:8001/v1/files/test?token=fixture", mimeType: "application/octet-stream", bytes: bytes.length, sha256: "a".repeat(64) });
    };
    t.after(() => {
      globalThis.fetch = original;
    });
    const input: SDKResult =
      kind === "image"
        ? {
            id: "request",
            model: "model",
            images: [{ url: "https://media.test/image" }],
          }
        : kind === "audio"
          ? {
              id: "request",
              model: "model",
              audio: {
                url: "https://media.test/audio",
                contentType: "audio/wav",
              },
            }
          : { jobId: "request", url: "https://media.test/video" };
    const result = await uploadResult(
      {
        serverOrigin: "http://127.0.0.1:8001",
        profileId: "profile",
        token: "fixture",
      },
      provider,
      kind,
      input,
      {
        requestId: "request",
        accountSubject: "owner",
        signal: controller.signal,
      },
    );
    assert.match(
      JSON.stringify(result),
      /http:\/\/127\.0\.0\.1:8001\/v1\/files\/test/,
    );
    assert.equal(downloads, 1);
    assert.equal(uploads, 1);
  });
}

test("cancelled media collection never proceeds to host upload", async (t) => {
  const controller = new AbortController();
  const provider = {
    id: "flow",
    async fetchArtifact() {
      controller.abort();
      return { body: new Blob(["media"]), mimeType: "image/png" };
    },
  } as unknown as ProviderAdapter;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Error("Must not upload after cancel");
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  await assert.rejects(
    uploadResult(
      {
        serverOrigin: "http://127.0.0.1:8001",
        profileId: "profile",
        token: "fixture",
      },
      provider,
      "image",
      {
        id: "request",
        model: "model",
        images: [{ url: "https://media.test/image" }],
      },
      {
        requestId: "request",
        accountSubject: "owner",
        signal: controller.signal,
      },
    ),
    { name: "AbortError" },
  );
});

test("interrupted artifact body retries the original URL once, without another generation or POST", async (t) => {
  const urls: string[] = [];
  let uploads = 0;
  const provider = {
    id: "flow",
    async fetchArtifact(url: string) {
      urls.push(url);
      return { mimeType: "image/png", body: urls.length === 1 ? new ReadableStream({ start(c) { c.error(Error("Interrupted download")); } }) : new Blob(["image"]) };
    },
  } as unknown as ProviderAdapter;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { uploads++; return Response.json({ id: "file", url: "http://127.0.0.1:8001/v1/files/file", mimeType: "image/png", bytes: 5, sha256: "a".repeat(64) }); };
  t.after(() => { globalThis.fetch = original; });
  await uploadResult({ serverOrigin: "http://127.0.0.1:8001", profileId: "profile", token: "fixture" }, provider, "image", {
    id: "request", model: "nano-banana-2.1", images: [{ url: "https://media.test/original" }],
  }, { requestId: "request", accountSubject: "owner", signal: new AbortController().signal });
  assert.deepEqual(urls, ["https://media.test/original", "https://media.test/original"]);
  assert.equal(uploads, 1);
});

test("artifact retries stop after two failed reads", async () => {
  let downloads = 0;
  const provider = { id: "flow", fetchArtifact: async () => { downloads++; throw Error("Download failed"); } } as unknown as ProviderAdapter;
  await assert.rejects(uploadResult({ serverOrigin: "http://127.0.0.1:8001", profileId: "profile", token: "fixture" }, provider, "image", {
    id: "request", model: "nano-banana-2.1", images: [{ url: "https://media.test/original" }],
  }, { requestId: "request", accountSubject: "owner", signal: new AbortController().signal }), /Download failed/);
  assert.equal(downloads, 2);
});

for (const fixture of [{ body: "", mimeType: "image/png" }, { body: "<html>Sign in</html>", mimeType: "text/html" }, { body: '{"error":"capacity"}', mimeType: "application/json" }])
  test(`empty/error file is never uploaded as successful media (${fixture.mimeType}/${fixture.body.length})`, async (t) => {
    const provider = { id: "flow", fetchArtifact: async () => ({ body: new Blob([fixture.body]), mimeType: fixture.mimeType }) } as unknown as ProviderAdapter;
    const original = globalThis.fetch;
    let uploads = 0;
    globalThis.fetch = async () => { uploads++; throw Error("Must not upload"); };
    t.after(() => { globalThis.fetch = original; });
    await assert.rejects(uploadResult({ serverOrigin: "http://127.0.0.1:8001", profileId: "profile", token: "fixture" }, provider, "image", {
      id: "request", model: "nano-banana-2.1", images: [{ url: "https://media.test/original" }],
    }, { requestId: "request", accountSubject: "owner", signal: new AbortController().signal }), { code: "ARTIFACT_INVALID" });
    assert.equal(uploads, 0);
  });
