import assert from "node:assert/strict";
import test from "node:test";
import type { ModelEntry } from "../src/shared/contracts.js";
import { generatorDownloadName, generatorMediaKind, generatorModel, generatorModels } from "../src/web/lib/generator-output.js";

test("Generator filters task models and preserves a selected offline model rather than silently rerouting", () => {
  const models = [
    { id: "text-offline", type: "text", available: false },
    { id: "image", type: "image", available: true },
    { id: "text-ready", type: "text", available: true },
  ] as ModelEntry[];
  assert.deepEqual(generatorModels(models, "text").map(model => model.id), ["text-offline", "text-ready"]);
  assert.equal(generatorModel(models, "text"), "text-ready");
  assert.equal(generatorModel(models, "text", "text-offline"), "text-offline");
  assert.equal(generatorModel(models, "video"), "");
});

test("Generator previews OpenAI image URLs without MIME and uses the submitted kind, not the current form", () => {
  assert.equal(generatorMediaKind({ url: "/v1/files/image" }, "image"), "image");
  assert.equal(generatorMediaKind({ dataUrl: "data:audio/wav;base64,UklGRg==" }, "image"), "audio");
  assert.equal(generatorMediaKind({ url: "/video", mimeType: "video/mp4" }, "text"), "video");
  assert.equal(generatorMediaKind({ text: "real response" }, "image"), "text");
});

test("Generator download names reflect actual media format without leaking prompt/account metadata", () => {
  assert.equal(generatorDownloadName({ mimeType: "image/jpeg" }, "image", 0), "generation-1.jpg");
  assert.equal(generatorDownloadName({ dataUrl: "data:audio/ogg;base64,YQ==" }, "audio", 1), "generation-2.ogg");
  assert.equal(generatorDownloadName({ url: "/video" }, "video", 0), "generation-1.mp4");
  assert.equal(generatorDownloadName({ url: "/image-with-unknown-mime" }, "image", 0), "generation-1");
});
