import test from "node:test";
import assert from "node:assert/strict";
import { createAdapters } from "../../src/extension/providers/index.js";
import { PROVIDERS, MODELS } from "../../src/shared/contracts.js";

test("registry composes all standard modality providers from the one canonical model list", () => {
  const providers = createAdapters();
  assert.deepEqual(
    providers.map((item) => item.id),
    Object.keys(PROVIDERS),
  );
  for (const provider of providers) {
    assert.equal("execute" in provider, false);
    assert.equal("protocol" in provider, false);
    for (const kind of ["text", "image", "video", "audio"] as const)
      assert.equal(
        typeof provider[kind],
        MODELS.some(
          (model) => model.providerId === provider.id && model.kind === kind,
        )
          ? "function"
          : "undefined",
      );
  }
});
