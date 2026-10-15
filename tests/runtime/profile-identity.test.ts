import assert from "node:assert/strict";
import test from "node:test";
import { getOrCreateProfileId } from "../../src/extension/runtime/runtime.js";

const id = "159412ea-389f-422e-aa7b-7a2725ca734d";
test("concurrent profile reads persist one identity and retain it across restarts", async () => {
  const values: Record<string, unknown> = {};
  let generated = 0;
  const storage = {
    async get() {
      return { ...values };
    },
    async set(update: Record<string, unknown>) {
      Object.assign(values, update);
    },
  };
  const create = () => {
    generated++;
    return id;
  };
  assert.deepEqual(
    await Promise.all([
      getOrCreateProfileId(storage, create),
      getOrCreateProfileId(storage, create),
    ]),
    [id, id],
  );
  assert.equal(await getOrCreateProfileId(storage, create), id);
  assert.equal(await getOrCreateProfileId({ ...storage }, create), id);
  assert.equal(generated, 1);
});
test("invalid saved identity is preserved without replacing the profile", async () => {
  let writes = 0;
  const storage = {
    async get() {
      return { "browser.profileId": "invalid" };
    },
    async set() {
      writes++;
    },
  };
  await assert.rejects(
    getOrCreateProfileId(storage),
    /Stored browser profile identity is invalid/,
  );
  assert.equal(writes, 0);
});
test("failed profile storage can be retried without retaining a rejected initializer", async () => {
  let reads = 0;
  const storage = {
    async get() {
      if (++reads === 1) throw Error("storage unavailable");
      return {};
    },
    async set() {},
  };
  await assert.rejects(
    getOrCreateProfileId(storage, () => id),
    /storage unavailable/,
  );
  assert.equal(await getOrCreateProfileId(storage, () => id), id);
  await assert.rejects(
    getOrCreateProfileId(storage, () => "invalid"),
    /Generated browser profile identity is invalid/,
  );
});
