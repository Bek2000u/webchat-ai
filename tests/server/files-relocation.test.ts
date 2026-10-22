import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiStore } from "../../src/server/storage.js";
import { FileStore, fileResponse } from "../../src/server/files.js";

test("moving data keeps existing media readable without rewriting its journal or file rows", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "webchat-ai-media-move-"));
  const previous = join(temporary, "previous"), next = join(temporary, "next");
  await mkdir(previous);
  let store = await ApiStore.open({ path: join(previous, "app.sqlite3") });
  try {
    const files = new FileStore(store.db, join(previous, "files"));
    const original = await files.put(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("preserved media")); controller.close(); },
    }), "existing-request", "text/plain", () => true);
    const row = store.db.prepare("SELECT * FROM files WHERE id=?").get(original.id);
    await store.close();
    await rename(previous, next);
    store = await ApiStore.open({ path: join(next, "app.sqlite3") });
    const moved = new FileStore(store.db, join(next, "files")).get(original.id)!;
    assert.equal(moved.path, join(next, "files", original.id));
    assert.equal(moved.sha256, original.sha256);
    assert.deepEqual(store.db.prepare("SELECT * FROM files WHERE id=?").get(original.id), row);
    assert.equal(await (await fileResponse(moved.path, moved.mimeType)).text(), "preserved media");
    const range = await fileResponse(moved.path, moved.mimeType, "bytes=0-8");
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "preserved");
  } finally {
    await store.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
