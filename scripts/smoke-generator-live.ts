import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

// Real Generator clicks -> live local API -> installed companion -> vendor.
// No interception, mock results, injected errors, API setting changes or SDK retries.
const origin = "http://127.0.0.1:8001";
const directory = resolve(".tmp", `generator-live-${Date.now()}`);
// Recheck an existing run without issuing any new generation request.
const verificationSource = process.env.GENERATOR_VERIFY_REPORT;
const selectedKinds = new Set(process.env.GENERATOR_SMOKE_ONLY?.split(",").filter(Boolean));
const sourceReports = verificationSource ? await Promise.all(verificationSource.split(";").map(async path => JSON.parse(await readFile(path, "utf8")))) : [];
const existingReport = sourceReports.length ? { ...sourceReports[0], results: sourceReports.flatMap(report => report.results) } : undefined;
await mkdir(directory, { recursive: true });
async function json(path: string) {
  const response = await fetch(origin + path);
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const accountsBefore = await json("/api/accounts");
const before = existingReport?.before ?? await json("/api/stats/operations");
const routing = (await json("/api/config")).textProviderOrder;
const slots = (accounts: any[]) => accounts.flatMap(account => account.providers.map((p: any) => ({
  profile: account.id, chromeEmail: account.chrome_email, provider: p.provider_id,
  siteAccount: p.account_subject, status: p.status, enabled: p.enabled,
  tier: p.account_status?.account_tier, error: p.connection_error, health: p.health,
})));
for (const provider of ["gemini_web", "flow", "google_vids"])
  assert(slots(accountsBefore).some(p => p.provider === provider && p.status === "ready"), `No ready ${provider}; no smoke submitted`);
console.log(JSON.stringify({ phase: "connected", profiles: accountsBefore.length, ready: slots(accountsBefore).filter(p => p.status === "ready").length, routing }));
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ru-RU" });
const pageErrors: string[] = [];
context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
const results: any[] = existingReport?.results ?? [];
let after: any, reconciliation: any;
const report = async () => writeFile(resolve(directory, "report.json"), JSON.stringify({
  realProviderRequests: !verificationSource, verificationSource, transport: "Generator UI clicks, no interceptions", routing,
  before, accountsBefore: slots(accountsBefore), results, after, reconciliation, pageErrors,
}, null, 2));
async function select(page: Page, id: string, label: string) {
  await page.locator(id).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}
async function model(page: Page, id: string) {
  await page.locator("#tb-model").click();
  await page.locator('[data-slot="popover-content"]').getByRole("button")
    .filter({ has: page.locator(`span:text-is("${id}")`) }).click();
}
function validateArtifact(body: Buffer, mime: string, kind: string) {
  assert(body.length > 100, "Empty/truncated artifact");
  if (kind === "audio") {
    assert.equal(body.toString("ascii", 0, 4), "RIFF");
    assert.equal(body.toString("ascii", 8, 12), "WAVE");
  } else if (kind === "video") assert.equal(body.toString("ascii", 4, 8), "ftyp");
  else {
    assert.match(mime, /^image\//);
    assert(body.subarray(0, 3).equals(Buffer.from([255,216,255])) || body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP"), "Unrecognized image bytes");
  }
  return { bytes: body.length, mime, sha256: createHash("sha256").update(body).digest("hex") };
}
async function run(name: string, kind: string, selectedModel: string, prompt: string) {
  if (selectedKinds.size && !selectedKinds.has(kind)) return;
  const row: any = { name, kind, selectedModel, startedAt: new Date().toISOString() };
  const page = await context.newPage();
  results.push(row);
  const started = Date.now();
  let submitted = 0;
  const endpoints: Record<string, string> = { text: "/v1/chat/completions", image: "/v1/images/generations", video: "/v1/videos", audio: "/v1/audio/speech" };
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === endpoints[kind]) {
      submitted++;
      row.submittedBody = request.postDataJSON();
    }
  });
  try {
    await page.goto(origin + "/generator");
    await page.locator("#tb-model").waitFor();
    const tabs: Record<string, string> = { text: "Текст", image: "Фото", video: "Видео", audio: "Аудио" };
    await page.getByRole("tab", { name: tabs[kind], exact: true }).click();
    await model(page, selectedModel);
    if (kind === "video") {
      await select(page, "#tb-duration", "4 с");
      await select(page, "#tb-video-resolution", "360P");
    }
    if (kind === "image") await select(page, "#tb-size", "1K");
    if (kind === "audio") {
      await page.locator("#tb-voice:not([disabled])").waitFor({ timeout: 15000 });
      await select(page, "#tb-voice", "Schedar");
    }
    await page.locator("#tb-prompt").fill(prompt);
    const incoming = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === endpoints[kind], { timeout: 660000 });
    await page.getByRole("button", { name: kind === "audio" ? "Озвучить" : "Сгенерировать", exact: true }).click();
    console.log(JSON.stringify({ name, phase: "submitted", model: selectedModel }));
    const response = await incoming;
    await response.finished();
    row.http = response.status();
    row.requestId = response.headers()["x-request-id"];
    if (kind === "audio" && response.ok()) row.audioHeaders = response.headers();
    else {
      const payload = await response.json();
      if (!response.ok()) throw Error(`${payload.error?.code}: ${payload.error?.message}`);
      if (kind === "text") {
        row.resolvedModel = payload.model;
        row.text = payload.choices?.[0]?.message?.content;
        assert.equal(typeof row.text, "string");
        assert(row.text.includes("SMOKE_OK"), "Text did not contain SMOKE_OK");
      }
      if (kind === "image") {
        assert.equal(payload.data?.length, 1);
        const file = await context.request.get(new URL(payload.data[0].url, origin).href);
        assert(file.ok(), `Image HTTP ${file.status()}`);
        row.artifact = validateArtifact(await file.body(), file.headers()["content-type"] ?? "", kind);
      }
      if (kind === "video") row.requestId = payload.id;
    }
    const section = page.getByRole("region", { name: "Результат генерации" });
    await page.waitForFunction(() => document.querySelector('section[aria-label="Результат генерации"]')?.getAttribute("aria-busy") === "false", undefined, { timeout: 660000 });
    await section.locator("summary").waitFor({ timeout: 15000 });
    assert.equal(await section.getByRole("alert").count(), 0, (await section.innerText()).slice(0, 1000));
    const journal = await json(`/api/jobs/${row.requestId}`);
    row.journal = { status: journal.status, provider: journal.provider_id, worker: journal.worker_id, attempts: journal.attempts, durationMs: journal.duration_ms, error: journal.error_details };
    assert.equal(journal.status, "succeeded", JSON.stringify(journal.error_details));
    assert.equal(journal.model, selectedModel);
    if (kind === "video") {
      // Browser fetch preserves same-origin local UI auth. APIRequestContext
      // intentionally has no UI fetch metadata and requires a client API key.
      const file = await page.evaluate(async path => {
        const response = await fetch(path);
        const blob = await response.blob();
        const data = await new Promise<string>((done, fail) => {
          const reader = new FileReader(); reader.onload = () => done(String(reader.result));
          reader.onerror = () => fail(reader.error); reader.readAsDataURL(blob);
        });
        return { status: response.status, mime: blob.type, data };
      }, `/v1/videos/${row.requestId}/content`);
      assert.equal(file.status, 200, `Video HTTP ${file.status}`);
      row.artifact = validateArtifact(Buffer.from(file.data.split(",")[1], "base64"), file.mime, kind);
      await section.locator("video").waitFor();
    }
    if (kind === "image") {
      await section.locator("img").waitFor();
      await section.locator("img").evaluate(image => new Promise<void>((done, fail) => {
        if ((image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth) return done();
        image.addEventListener("load", () => done(), { once: true }); image.addEventListener("error", () => fail(Error("Image preview failed")), { once: true });
      }));
    }
    if (kind === "audio") {
      await section.locator("audio").waitFor();
      // Read the actual WAV consumed by the page. CDP may expose an empty
      // response.body() for an audio download even though fetch decoded it.
      const source = await section.locator("audio").getAttribute("src");
      assert(source && source.startsWith("data:audio/"), "Missing audio bytes in Generator preview");
      const match = /^data:([^;]+);base64,(.*)$/.exec(source)!;
      row.artifact = validateArtifact(Buffer.from(match[2], "base64"), match[1], kind);
      await section.locator("audio").evaluate(audio => new Promise<void>((done, fail) => {
        if ((audio as HTMLAudioElement).readyState >= 1) return done();
        audio.addEventListener("loadedmetadata", () => done(), { once: true });
        audio.addEventListener("error", () => fail(Error("Audio preview failed")), { once: true });
      }));
      row.audioDuration = await section.locator("audio").evaluate(audio => (audio as HTMLAudioElement).duration);
      assert(row.audioDuration > 0);
    }
    if (kind === "text") assert((await section.innerText()).includes("SMOKE_OK"));
    row.uiPreview = true;
    assert.equal(submitted, 1, "Generator submitted more than one logical HTTP request");
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.error = error instanceof Error ? error.message : String(error);
    if (row.requestId && !row.journal) {
      const journal = await json(`/api/jobs/${row.requestId}`).catch(() => undefined);
      if (journal) row.journal = { status: journal.status, provider: journal.provider_id, worker: journal.worker_id, attempts: journal.attempts, error: journal.error_details };
    }
  } finally {
    row.logicalPosts = submitted;
    row.durationMs = Date.now() - started;
    await page.screenshot({ path: resolve(directory, name + ".png"), fullPage: true }).catch(() => {});
    console.log(JSON.stringify(row));
    await report();
    await page.close();
  }
}
try {
  if (!verificationSource) {
  await Promise.all([1, 2].map(n => run(`text-auto-${n}`, "text", "auto", `Reply with exactly SMOKE_OK and nothing else. Local Generator smoke ${n}.`)));
  await run("flow-image", "image", "nano-banana-2-lite", "A single blue ceramic cup on a plain white table, studio photograph, no text.");
  await run("flow-video", "video", "gemini-omni-flash-preview", "A blue ceramic cup standing still on a white table, gentle camera pan, daylight.");
  await run("vids-tts", "audio", "gemini-3.8-flash-tts", "Проверка генератора. Соединение работает, озвучка успешно создана.");
  } else {
    // Re-read only existing journals/artifacts. Preserve original UI-harness
    // outcomes; distinguish them from actual provider/server verification.
    for (const row of results) {
      assert(row.requestId, `No submitted request for ${row.name}`);
      const journal = await json(`/api/jobs/${row.requestId}`);
      assert.equal(journal.status, "succeeded", journal.error || row.name);
      row.serverVerification = { status: "passed", attempts: journal.attempts };
      if (row.kind !== "text") {
        const url = row.kind === "video" ? journal.result.url : row.kind === "audio" ? journal.result.audio.url : journal.result.images?.[0]?.url;
        assert(url, "Missing stored artifact URL");
        const file = await fetch(url);
        assert(file.ok, `Stored artifact HTTP ${file.status}`);
        row.serverVerification.artifact = validateArtifact(Buffer.from(await file.arrayBuffer()), file.headers.get("content-type") ?? "", row.kind);
      }
      row.journal = { ...row.journal, status: journal.status, attempts: journal.attempts };
    }
  }
  after = await json("/api/stats/operations");
  const accountsAfter = await json("/api/accounts");
  const rows = await json("/api/jobs?limit=1000");
  const finished = rows.filter((row: any) => ["succeeded", "failed"].includes(row.status));
  assert.equal(after.summary.total, rows.length);
  assert.equal(after.summary.finished, finished.length);
  assert.equal(after.summary.failed, rows.filter((row: any) => row.status === "failed").length);
  const durations = finished.map((row: any) => row.duration_ms).filter((value: unknown) => typeof value === "number" && value >= 0);
  if (durations.length) assert(Math.abs(after.summary.averageDurationMs - durations.reduce((a: number, b: number) => a + b, 0) / durations.length) < 0.01);
  for (const operation of after.operations) {
    const matching = rows.filter((row: any) => row.kind === operation.operation);
    assert.equal(operation.total, matching.length);
    assert.equal(operation.succeeded, matching.filter((row: any) => row.status === "succeeded").length);
  }
  const health: any[] = [];
  for (const row of results) for (const attempt of row.journal?.attempts ?? []) {
    const slot = slots(accountsAfter).find(p => p.profile === attempt.profileId && p.provider === attempt.provider);
    assert(slot?.health.lastAssignedAt, "Dispatch did not update health assignment");
    if (attempt.decision === "completed") assert(slot.health.lastSuccess?.at >= attempt.startedAt, "Completed call did not update health success");
    health.push({ request: row.requestId, profile: attempt.profileId, provider: attempt.provider, health: slot.health });
  }
  const auto = results.filter(row => row.kind === "text" && row.status === "passed");
  const profiles = new Set(auto.map(row => row.journal.attempts.at(-1)?.profileId));
  const statsPage = await context.newPage();
  const statsResponse = statsPage.waitForResponse(response => new URL(response.url()).pathname === "/api/stats/operations");
  await statsPage.goto(origin + "/stats");
  const displayed = await (await statsResponse).json();
  await statsPage.getByText("Время по операциям", { exact: true }).waitFor();
  const completedCard = statsPage.locator('[data-slot="card"]').filter({ has: statsPage.locator('dt:text-is("Завершено")') });
  assert.equal(Number((await completedCard.locator("dd").innerText()).replace(/\s/g, "")), displayed.summary.finished);
  const errorsCard = statsPage.locator('[data-slot="card"]').filter({ has: statsPage.locator('dt:text-is("Ошибки")') });
  assert.equal(Number((await errorsCard.locator("dd").innerText()).replace(/\s/g, "")), displayed.summary.failed);
  await statsPage.screenshot({ path: resolve(directory, "stats.png"), fullPage: true });
  reconciliation = { statsMatchJournal: true, statsUI: true, autoProfiles: [...profiles], routingObserved: auto.map(row => ({ id: row.requestId, attempts: row.journal.attempts })), retriesObserved: results.reduce((total, row) => total + Math.max(0, (row.journal?.attempts.length ?? 0) - 1), 0), health, accountsAfter: slots(accountsAfter) };
  assert.equal(pageErrors.length, 0, "UI threw JavaScript errors");
} catch (error) {
  reconciliation = { ...(reconciliation ?? {}), failure: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  await report();
  await browser.close();
  console.log(JSON.stringify({ report: resolve(directory, "report.json"), uiHarnessPassed: results.filter(row => row.status === "passed").length, uiHarnessFailed: results.filter(row => row.status !== "passed").length, existingRequestsVerified: results.filter(row => row.serverVerification?.status === "passed").length, reconciliation: reconciliation?.failure ?? "passed" }));
}
if (!verificationSource && results.some(row => row.status !== "passed")) process.exitCode = 1;
