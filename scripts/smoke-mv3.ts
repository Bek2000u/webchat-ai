import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { startApi } from "../src/server/index.js";
import { PROVIDERS } from "../src/shared/contracts.js";

/// <reference types="chrome" />
/**
 * Run after building the server packages and WXT extension:
 *   npx playwright install chromium
 *   npx tsx scripts/smoke-mv3.ts
 *
 * Uses only a fresh temporary profile/database. A deny proxy blocks all Chrome
 * network traffic except the exact temporary host address, including the built
 * extension's initial default address. No provider is enabled or submitted.
 */

interface SmokeReport {
  status: "passed" | "blocked";
  browserVersion?: string;
  extensionId: string;
  checks: {
    serviceWorker: boolean;
    options: boolean;
    registration: boolean;
    socketIO: boolean;
    noProviderJobs: boolean;
  };
  blockedNetworkRequests: number;
  error?: string;
}

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function main() {
  const extensionPath = resolve(
    process.env.MV3_SMOKE_EXTENSION_PATH || "dist/extension/chrome-mv3",
  );
  const manifest = JSON.parse(
    await readFile(join(extensionPath, "manifest.json"), "utf8"),
  ) as { key: string; manifest_version: number };
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.key, "Built extension must have its stable public key");
  const extensionId = [
    ...createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32),
  ]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");
  const report: SmokeReport = {
    status: "blocked",
    extensionId,
    checks: {
      serviceWorker: false,
      options: false,
      registration: false,
      socketIO: false,
      noProviderJobs: false,
    },
    blockedNetworkRequests: 0,
  };
  const temporary = await mkdtemp(join(tmpdir(), "webchat-ai-mv3-smoke-"));
  let context: BrowserContext | undefined;
  let host: Awaited<ReturnType<typeof startApi>> | undefined;
  const denyProxy = createServer((_request, response) => {
    report.blockedNetworkRequests++;
    response.writeHead(403, { Connection: "close" });
    response.end("Isolated browser smoke blocks this destination");
  });
  denyProxy.on("connect", (_request, socket) => {
    report.blockedNetworkRequests++;
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  try {
    host = await startApi({
      DATA_DIR: join(temporary, "host"),
      HOST: "127.0.0.1",
      PORT: "0",
      EXTENSION_ORIGINS: `chrome-extension://${extensionId}`,
    });
    await until(() => !!host?.server.listening, "temporary host listener");
    const address = host.server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) =>
      denyProxy.listen(0, "127.0.0.1", resolve),
    );
    const proxyAddress = denyProxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");

    context = await chromium.launchPersistentContext(
      join(temporary, "profile"),
      {
        headless: true,
        channel: "chromium",
        ...(process.env.MV3_SMOKE_BROWSER_PATH
          ? { executablePath: process.env.MV3_SMOKE_BROWSER_PATH }
          : {}),
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          "--disable-features=DisableLoadExtensionCommandLineSwitch",
          `--proxy-server=http://127.0.0.1:${proxyAddress.port}`,
          `--proxy-bypass-list=<-loopback>;127.0.0.1:${address.port}`,
        ],
      },
    );
    report.browserVersion = context.browser()?.version();
    const worker =
      context
        .serviceWorkers()
        .find((item) =>
          item.url().startsWith(`chrome-extension://${extensionId}/`),
        ) || (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
    assert.ok(worker.url().startsWith(`chrome-extension://${extensionId}/`));
    report.checks.serviceWorker = true;
    const options = await context.newPage();
    const pageErrors: string[] = [];
    options.on("pageerror", (error) => pageErrors.push(error.message));
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator("#serverOrigin").waitFor();
    assert.equal(
      await options.locator(".provider").count(),
      Object.keys(PROVIDERS).length,
    );
    report.checks.options = true;
    await options.locator("#serverOrigin").fill(origin);
    await options.locator("#saveConnection").click();
    await until(
      async () =>
        /^[0-9a-f-]{36}$/.test(
          (await options.locator("#clientEmail").getAttribute("title")) || "",
        ),
      "extension profile identity",
    ).catch(async (error) => {
      const uiError = await options.locator("#clientMessage").textContent();
      throw new Error(
        `${error.message}; options: ${uiError || pageErrors.join("; ") || "no reported error"}`,
      );
    });
    const profileId = (await options
      .locator("#clientEmail")
      .getAttribute("title"))!;
    await until(
      () => !!host?.host.connectedIds().has(profileId),
      "real extension Socket.IO hello",
    );
    await until(
      async () =>
        (await options
          .locator("#clientStatus")
          .getAttribute("data-connected")) === "true",
      "connected options status",
    );
    const profile = await host.store.getProfile(profileId);
    assert.equal(profile?.providers.length, Object.keys(PROVIDERS).length);
    assert.ok(profile?.providers.every((provider) => !provider.available));
    assert.equal((await host.store.listRequests()).length, 0);
    report.checks.socketIO = true;
    report.checks.registration = true;
    report.checks.noProviderJobs = true;
    assert.deepEqual(pageErrors, []);
    report.status = "passed";
  } catch (error) {
    report.error =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await host?.close();
    denyProxy.closeAllConnections();
    await new Promise<void>((resolve) =>
      denyProxy.listening ? denyProxy.close(() => resolve()) : resolve(),
    );
    // temporary was created here, under the OS temp directory; no existing
    // Chrome profile, database or extension installation is removed.
    await rm(temporary, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    await mkdir(resolve(".tmp"), { recursive: true });
    await writeFile(
      resolve(".tmp/mv3-smoke.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  }
}

await main();
