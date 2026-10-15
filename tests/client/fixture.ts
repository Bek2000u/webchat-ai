import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/api.js";
import { ApiStore } from "../../src/server/storage.js";
import { FileStore } from "../../src/server/files.js";
import { BrowserDispatcher } from "../../src/server/runtime.js";
import { type SDKRequest, type SDKResult } from "../../src/shared/contracts.js";

/** Actual API + Vercel adapter + SQLite; only the Chrome execution is a fixture. */
export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "chat2api-contract-"));
  const store = await ApiStore.open({ path: ":memory:" });
  const host = new BrowserDispatcher(store, []),
    files = new FileStore(store.db, dir);
  const calls: SDKRequest[] = [];
  let execute: (
    request: SDKRequest,
    id: string,
  ) => Promise<SDKResult> = async () => ({ text: "SDK fixture answer" });
  const submit = host.submit.bind(host);
  host.submit = (request) => {
    const record = submit(request);
    calls.push(record.request);
    store.startRequest(record.id, "fixture-chrome");
    void execute(request, record.id).then(
      (result) => store.completeRequest(record.id, result),
      (error) =>
        store.failRequest(record.id, {
          code: error.code ?? "PROVIDER_ERROR",
          message: error.message ?? "Fixture error",
        }),
    );
    return store.getRequest(record.id)!;
  };
  const app = createApp({
    store,
    host,
    files,
    config: { dataDir: dir, bootstrapApiKey: "contract-key" },
  });
  const fetch: typeof globalThis.fetch = async (input, init) =>
    app.fetch(new Request(input, init));
  return {
    app,
    store,
    host,
    files,
    calls,
    fetch,
    config: {
      baseURL: "http://127.0.0.1:19999/v1",
      apiKey: "contract-key",
      fetch,
      maxRetries: 0,
    },
    execute: (fn: typeof execute) => {
      execute = fn;
    },
    async close() {
      await host.close();
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
