import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { _electron as electron } from "playwright";
import { io, type Socket } from "socket.io-client";
import { BRIDGE_PATH, type Execute } from "../src/shared/contracts.js";
import { smokeExtensionUI } from "./extension-ui-fixture.js";

/** Owned isolated Electron fixture. No vendor tabs or real generations. */

const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "chat2api-desktop-smoke-"));
const output = resolve(".tmp/chat2api-desktop-smoke");
await mkdir(output, { recursive: true });
const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const env: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      (item): item is [string, string] => item[1] !== undefined,
    ),
  ),
  CHAT2API_DATA_DIR: dir,
  CHAT2API_SMOKE: "1",
  CHAT2API_PORT: "0",
  EXTENSION_ORIGINS: extensionOrigin,
  TEXT_PROVIDER_ORDER: "qwen-web,gemini-web",
};
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.CHAT2API_SMOKE_EXECUTABLE;
const desktop = await electron.launch({
  executablePath: packaged || require("electron"),
  args: packaged ? [] : [resolve(".")],
  env,
  timeout: 30000,
});
desktop.process().stderr?.on("data", (chunk) => process.stderr.write(chunk));
let socket: Socket | undefined,
  origin = "",
  executions = 0,
  executedModel = "";
try {
  const page = await desktop.firstWindow();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForURL(/\/dashboard$/);
  await page.locator("main h1").waitFor({ timeout: 15000 });
  await page.getByText("Последние запросы", { exact: true }).waitFor();
  origin = new URL(page.url()).origin;
  assert.deepEqual(await page.context().cookies(), []);
  assert.equal((await fetch(origin + "/api/accounts")).status, 200);
  assert.equal(
    (await fetch(origin + "/api/admin/login", { method: "POST" })).status,
    404,
  );
  assert.equal(
    (await fetch(origin + "/api/browser/enroll", { method: "POST" })).status,
    404,
  );
  assert.equal((await fetch(origin + "/api/enrollments")).status, 404);
  assert.equal((await fetch(origin + "/v1/models")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/accounts", {
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    await page.evaluate(async () => (await fetch("/v1/models")).status),
    200,
  );
  const key = await (
    await fetch(origin + "/api/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "isolated desktop smoke" }),
    })
  ).json();
  assert.equal(
    (
      await fetch(origin + "/v1/models", {
        headers: { Authorization: `Bearer ${key.secret}` },
      })
    ).status,
    200,
  );
  socket = io(origin, {
    path: BRIDGE_PATH,
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { Origin: extensionOrigin },
  });
  await new Promise<void>((done, fail) => {
    socket!.once("connect", done);
    socket!.once("connect_error", fail);
  });
  socket.on("execute", (value: Execute) => {
    executions++;
    executedModel = value.request.options.model;
    socket!.emit("result", {
      id: value.id,
      result: { text: "Desktop fixture OK", chunks: [] },
    });
  });
  const profileId = randomUUID();
  socket.emit("hello", {
    profileId,
    token: randomUUID(),
    extensionVersion: "fixture",
    providers: [
      { id: "qwen_web", available: true, accountTier: "free" },
      { id: "gemini_web", available: true, accountTier: "free" },
    ],
  });
  const deadline = Date.now() + 5000;
  while (
    !(await (await fetch(origin + "/api/accounts")).json()).some(
      (p: { id: string }) => p.id === profileId,
    )
  ) {
    assert(Date.now() < deadline, "Automatic hello registration timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
  const response = await fetch(origin + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "auto",
      messages: [{ role: "user", content: "fixture only" }],
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.choices[0].message.content, "Desktop fixture OK");
  assert.equal(executions, 1);
  assert.equal(executedModel, "qwen-web", "Desktop must forward TEXT_PROVIDER_ORDER to its API process");
  await page.reload();
  await page.getByText("Последние запросы", { exact: true }).waitFor();
  const palettes: Record<string, string> = {};
  async function screenshot(name: string) {
    const png = await desktop.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(
          undefined,
          { stayHidden: true, stayAwake: true },
        )
      )
        .toPNG()
        .toString("base64"),
    );
    await writeFile(join(output, name + ".png"), Buffer.from(png, "base64"));
  }
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.theme = theme;
    }, theme);
    palettes[theme] = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
    );
    assert.match(palettes[theme], /oklch/);
    assert.equal(
      await page
        .locator('[data-slot="card"]')
        .first()
        .evaluate((el) => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--card)";
          document.body.append(probe);
          const expected = getComputedStyle(probe).backgroundColor,
            actual = getComputedStyle(el).backgroundColor;
          probe.remove();
          return actual === expected;
        }),
      true,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await screenshot(theme);
  }
  for (const route of [
    "accounts",
    "providers",
    "stats",
    "requests",
    "api-keys",
    "playground",
    "generator",
    "settings",
  ]) {
    await page.goto(origin + "/" + route);
    await page.locator("main h1").waitFor();
    assert(!page.url().includes("/login"));
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await smokeExtensionUI(desktop, output);
  assert.equal(
    await page.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    ),
    "undefined",
  );
  await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.close(),
  );
  assert.equal(
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.isVisible(),
    ),
    false,
  );
  assert.equal((await fetch(origin + "/health/ready")).status, 200);
  console.log(
    JSON.stringify({
      status: "passed",
      localUI: true,
      noAdmin: true,
      noPairing: true,
      automaticHello: true,
      clientKeys: true,
      singleDispatch: executions,
      configuredAutoRoute: executedModel,
      palettes,
      mobileOverflow: false,
      extensionUIFixture: true,
      trayKeepsHost: true,
      realProviderRequests: 0,
      screenshots: output,
    }),
  );
} finally {
  socket?.disconnect();
  await desktop.close();
}
await assert.rejects(
  fetch(origin + "/health/ready", { signal: AbortSignal.timeout(2000) }),
);
console.log("Quit stops the owned local host; fixture data retained at " + dir);
