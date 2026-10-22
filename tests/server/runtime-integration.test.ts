import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { io } from "socket.io-client";
import OpenAI from "openai";
import { BRIDGE_PATH, type RequestRecord } from "../../src/shared/contracts.js";
import {
  BrowserRuntime,
  type ProviderAdapter,
  type ProviderTabLike,
} from "../../src/extension/runtime/runtime.js";
import {
  FlowImage,
  type FlowPageResponse,
} from "../../src/extension/providers/flow/index.js";
import { FlowService } from "../../src/extension/providers/flow/operations.js";
import { proto } from "../../src/extension/providers/flow/rpc.js";
import { startApi } from "../../src/server/index.js";

class MemoryStorage {
  async get(key: string): Promise<Record<string, unknown>> {
    return { [key]: key.startsWith("provider.enabled:") ? true : undefined };
  }
  async set(_value: Record<string, unknown>): Promise<void> {}
}
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("Integration condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
const receipt = (data: unknown[]): FlowPageResponse => ({
  ok: true,
  status: 200,
  submitted: true,
  data,
});
const tab: ProviderTabLike = {
  restore: async () => {},
  ensure: async () => 1,
  removed: async () => {},
  open: async () => 1,
  matches: () => true,
  async execute() {
    return undefined;
  },
};

test("HTTP client → real browser runtime → native Flow batch → HTTP uploads and files; disconnect never resubmits", async (t) => {
  const parent = resolve(".tmp");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(resolve(parent, "runtime-integration-"));
  assert.ok(directory.startsWith(parent + sep));
  const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const host = await startApi({
    DATA_DIR: directory,
    HOST: "127.0.0.1",
    PORT: "0",
    EXTENSION_ORIGINS: extensionOrigin,
    BOOTSTRAP_API_KEY: "isolated-integration-key",
  });
  if (!host.server.listening) await once(host.server, "listening");
  const address = host.server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}`;
  let runtime: BrowserRuntime | undefined;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local: storage } },
  });
  t.after(async () => {
    runtime?.disconnect();
    await host.close();
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
    await rm(directory, { recursive: true, force: true });
  });
  const profileId = crypto.randomUUID(),
    token = "isolated-profile-token-at-least-16";
  host.store.createProfile(profileId, token, "Test Chrome");
  let submitCalls = 0,
    uploadCalls = 0;
  let releaseBlocked: (() => void) | undefined;
  let block = false;
  const submittedPrompts: string[][] = [];
  const service = new FlowService({
    verifyAccount: async () => {},
    executeCaptcha: async () => "isolated-native-captcha",
    fetch: async (input) => {
      const url = String(input);
      if (url.startsWith("https://input.test/"))
        return new Response(new Uint8Array([9, 8, 7]), {
          headers: { "Content-Type": "image/png" },
        });
      assert.match(url, /^https:\/\/example\.googleusercontent\.com\//);
      const index = Number(url.split("/").at(-1));
      return new Response(new Uint8Array([1, 2, 3, index]), {
        headers: { "Content-Type": "image/png" },
      });
    },
    requestRpc: async (rpc, signal) => {
      signal.throwIfAborted();
      if (rpc.id === "jHPbke")
        return receipt(["projects/isolated-flow-project"]);
      if (rpc.id === "maseQ") return receipt([["reference-" + ++uploadCalls]]);
      assert.equal(rpc.id, "ogiZ0b");
      const requests = rpc.data[1] as unknown[][];
      submitCalls++;
      submittedPrompts.push(
        requests.map((request) =>
          String((request[8] as string[][][])[0][0][0]),
        ),
      );
      if (block)
        await new Promise<void>((resolve) => {
          releaseBlocked = resolve;
        });
      return receipt([
        requests.map((request, index) =>
          proto({
            1: "media-" + index,
            6: proto({ 9: [3] }),
            7: [
              proto({
                2: request[3],
                14: "https://example.googleusercontent.com/" + index,
              }),
            ],
          }),
        ),
      ]);
    },
  });
  const provider: ProviderAdapter = {
    id: "flow",
    tab,
    detectAccount: async () => ({ accountSubject: "isolated@example.test" }),
    image: (model, context) => new FlowImage(model, service, context),
    fetchArtifact: (url, signal) => service.fetchArtifact(url, signal),
  };
  runtime = new BrowserRuntime([provider], storage, {
    extensionVersion: "test",
    socketFactory: (url, auth) =>
      io(url, {
        path: BRIDGE_PATH,
        auth,
        transports: ["websocket"],
        autoConnect: false,
        extraHeaders: { Origin: extensionOrigin },
      }),
  });
  runtime.settings = { profileId, token, serverOrigin: baseURL };
  await runtime.connect();
  await until(() => host.host.connectedIds().has(profileId));
  const client = new OpenAI({
    baseURL: baseURL + "/v1",
    apiKey: "isolated-integration-key",
    maxRetries: 0,
  });
  const reference = (suffix: string) => ({
    type: "image" as const,
    source: { type: "url" as const, value: "https://input.test/" + suffix },
    metadata: { role: "reference" as const },
  });
  const imageInput = {
    model: "nano-banana-2.1",
    prompt: "Default",
    n: 2,
    provider_options: {
      batch: [
        {
          prompt: [
            { type: "text", content: "First native item" },
            reference("one"),
          ],
        },
        {
          prompt: [
            { type: "text", content: "Second native item" },
            reference("two"),
          ],
        },
      ],
    },
  };
  const result = await client.images.generate(imageInput);
  assert.equal(submitCalls, 1);
  assert.equal(uploadCalls, 2);
  assert.deepEqual(submittedPrompts, [
    ["First native item", "Second native item"],
  ]);
  assert.equal(result.data!.length, 2);
  for (const [index, image] of result.data!.entries()) {
    assert.ok(image.url);
    const response = await fetch(image.url);
    assert.equal(response.status, 200);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      new Uint8Array([1, 2, 3, index]),
    );
  }
  const stored = host.store.listRequests();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "completed");
  assert.equal(
    host.store.db
      .prepare("SELECT COUNT(*) AS count FROM files")
      .get()?.count,
    2,
  );
  block = true;
  const accepted = fetch(baseURL + "/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: "Bearer isolated-integration-key",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "nano-banana-2.1", prompt: "Interrupted" }),
  });
  await until(() => submitCalls === 2);
  const interrupted = host.store.listRequests()[0]!;
  runtime.disconnect();
  assert.equal((await accepted).status, 503);
  await until(() => host.store.getRequest(interrupted.id)?.status === "error");
  assert.equal(
    host.store.getRequest(interrupted.id)?.error?.code,
    "outcome_unknown",
  );
  await runtime.connect();
  await until(() => host.host.connectedIds().has(profileId));
  releaseBlocked?.();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(submitCalls, 2);
  assert.equal(host.store.getRequest(interrupted.id)?.status, "error");
  assert.equal(host.store.listRequests().length, 2);
});
