import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { fileSigningSecret } from "./auth.js";
import { type Server } from "node:http";
import { createApp } from "./api.js";
import { ApiStore } from "./storage.js";
import { BrowserDispatcher } from "./runtime.js";
import { FileStore } from "./files.js";
import { loadSettings } from "./settings.js";

export async function startApi(env: NodeJS.ProcessEnv = process.env) {
  if (!["127.0.0.1", "::1"].includes(env.HOST || "127.0.0.1"))
    throw new Error("WebChat AI local host must listen on a loopback address");
  const dataDir = resolve(env.DATA_DIR || "data"),
    origins = (
      env.EXTENSION_ORIGINS ||
      (env.NODE_ENV === "development"
        ? "chrome-extension://pnamggpmjbeoohafaokfcjhpdmijmmda,chrome-extension://epmfnjjinilkfldoafibcgkpenbhlidm"
        : "chrome-extension://pnamggpmjbeoohafaokfcjhpdmijmmda")
    )
      .split(",")
      .map((value) => value.trim().replace(/\/$/, ""))
      .filter(Boolean);
  if (
    !origins.length ||
    origins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
  )
    throw new Error(
      "EXTENSION_ORIGINS must contain exact Chrome extension origins",
    );
  const settings = await loadSettings(dataDir,
    env.TEXT_PROVIDER_ORDER?.split(",").map((id) => id.trim()).filter(Boolean));
  const store = await ApiStore.open({
    path: resolve(env.DB_PATH || resolve(dataDir, "app.sqlite3")),
  });
  const host = new BrowserDispatcher(store, origins, settings.textProviderOrder),
    files = new FileStore(store.db, resolve(dataDir, "files"));
  const app = createApp({
    store,
    host,
    files,
    config: {
      dataDir,
      webDir: resolve(env.WEB_DIR || "dist/web"),
      bootstrapApiKey: env.BOOTSTRAP_API_KEY || "",
      fileSecret: await fileSigningSecret(dataDir),
      version: "0.2.0",
    },
  });
  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 8001),
  }) as Server;
  host.attach(server);
  if (!server.listening) await once(server, "listening");
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await host.close();
    if (server.listening)
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    await store.close();
  };
  return { app, server, store, host, files, close };
}
type ParentPort = { on(event: "message", listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void };
const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parent) {
  let instance: Awaited<ReturnType<typeof startApi>> | undefined;
  parent.on("message", async ({ data }) => {
    const message = data as { type?: string; env?: NodeJS.ProcessEnv };
    try {
      if (message.type === "start" && !instance) {
        instance = await startApi(message.env!);
        const address = instance.server.address();
        if (!address || typeof address === "string") throw Error("API address unavailable");
        parent.postMessage({ type: "ready", origin: `http://127.0.0.1:${address.port}` });
      } else if (message.type === "stop") {
        await instance?.close();
        process.exit(0);
      }
    } catch (error) {
      parent.postMessage({ type: "error", message: "WebChat AI local API could not start; check the port and data directory", ...(process.env.WEBCHAT_AI_SMOKE === "1" ? { diagnostic: error instanceof Error ? error.message : "Startup failed" } : {}) });
      await instance?.close().catch(() => {});
      process.exit(1);
    }
  });
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const instance = await startApi({
      ...process.env,
      ...(process.argv.includes("--dev") ? { NODE_ENV: "development" } : {}),
    }),
    address = instance.server.address();
  console.log(
    `WebChat AI API listening on ${typeof address === "object" && address ? address.port : "configured address"}`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      void instance.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
}
