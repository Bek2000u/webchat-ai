import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Real local API → installed extension → vendor. No mocks or SDK auto-retries.
const origin = process.env.SMOKE_ORIGIN || "http://127.0.0.1:8001";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const output = resolve(".tmp", `live-smoke-${Date.now()}.json`);
const rows: Record<string, unknown>[] = [];
const selected = new Set(process.env.SMOKE_MODELS?.split(",").map(value => value.trim()).filter(Boolean));
let secret = "";
async function api(path: string, body?: unknown) {
  return fetch(new URL(path, origin), {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(660_000),
  });
}
async function health() {
  const accounts = await (await api("/api/accounts")).json();
  return accounts.flatMap((account: any) => account.providers.map((p: any) => ({
    profileId: account.id, provider: p.provider_id, status: p.status,
    tier: p.account_status?.account_tier, error: p.connection_error_code, health: p.health,
  })));
}
const before = await health();
if (!before.some((p: any) => p.status === "ready")) throw Error("No connected ready providers; no generation submitted");
const created = await (await api("/api/api-keys", { label: "Temporary real smoke" })).json();
assert.ok(created.secret);
secret = created.secret;
await mkdir(resolve(".tmp"), { recursive: true });
async function save() {
  await writeFile(output, JSON.stringify({ startedAt, before, results: rows, after: await health() }, null, 2));
}
const startedAt = new Date().toISOString();
async function file(response: Response, kind: string) {
  assert.ok(response.ok, `File HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 100, "Empty or truncated media");
  const mime = response.headers.get("content-type") || "";
  if (kind === "audio") {
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  } else if (kind === "video") {
    assert.equal(bytes.toString("ascii", 4, 8), "ftyp");
  } else {
    assert.match(mime, /^image\//);
    assert.ok(bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"), "Unrecognized image bytes");
  }
  return { bytes: bytes.length, mime, sha256: createHash("sha256").update(bytes).digest("hex") };
}
async function run(name: string, provider: string | undefined, path: string, body: any, kind: string) {
  if (selected.size && !selected.has(body.model)) return;
  const started = Date.now();
  const row: Record<string, any> = { name, model: body.model };
  if (provider && !before.some((p: any) => p.provider === provider && p.status === "ready")) {
    row.status = "blocked"; row.reason = "No ready provider account";
    rows.push(row); console.log(JSON.stringify(row)); await save(); return;
  }
  try {
    console.log(JSON.stringify({ name, status: "started" }));
    const response = await api(path, body);
    row.http = response.status; row.requestId = response.headers.get("x-request-id");
    if (kind === "audio" && response.ok) row.artifact = await file(response, kind);
    else {
      const result = await response.json();
      if (!response.ok) throw Object.assign(Error(result.error?.message || "API failed"), { code: result.error?.code });
      if (kind === "text") {
        const text = result.choices?.[0]?.message?.content;
        assert.equal(typeof text, "string"); assert.ok(text.includes("SMOKE_OK"), "Unexpected response text");
        row.resolvedModel = result.model; row.text = text;
      } else if (kind === "image") {
        assert.equal(result.data?.length, 1);
        row.artifact = await file(await fetch(new URL(result.data[0].url, origin)), kind);
      } else {
        row.requestId = result.id;
        let video = result;
        const deadline = Date.now() + 630_000;
        while (!["completed", "failed"].includes(video.status)) {
          assert.ok(Date.now() < deadline, "Video polling deadline exceeded");
          await delay(1500);
          video = await (await api(`/v1/videos/${result.id}`)).json();
        }
        if (video.status === "failed") throw Object.assign(Error(video.error?.message || "Video failed"), { code: video.error?.code });
        row.artifact = await file(await api(`/v1/videos/${result.id}/content`), kind);
      }
    }
    row.status = "passed";
  } catch (error: any) {
    row.status = "failed"; row.error = { code: error.code, message: error.message };
  }
  if (row.requestId) {
    const journal = await api(`/api/jobs/${row.requestId}`);
    const detail = await journal.json();
    if (!journal.ok || !Array.isArray(detail.attempts)) {
      row.status = "failed";
      row.error = { code: "SMOKE_REQUEST_ID_MISMATCH", message: "API request ID does not resolve to its execution journal" };
    } else {
      row.attempts = detail.attempts;
      row.journalStatus = detail.status;
    }
  }
  row.durationMs = Date.now() - started;
  rows.push(row); console.log(JSON.stringify(row)); await save();
}
const text = (model: string) => ({ model, messages: [{ role: "user", content: "Reply with exactly SMOKE_OK and nothing else." }] });
try {
  await Promise.all([
    ...[["chatgpt-web", "chatgpt_web"], ["gemini-web", "gemini_web"], ["qwen-web", "qwen_web"], ["deepseek-web", "deepseek_web"]].map(([model, provider]) => run(model, provider, "/v1/chat/completions", text(model), "text")),
    run("flow-image", "flow", "/v1/images/generations", { model: "nano-banana-2-lite", prompt: "A single blue ceramic cup on a plain white table, studio photograph, no text.", n: 1, size: "1k" }, "image"),
    run("flow-video", "flow", "/v1/videos", { model: "gemini-omni-flash-preview", prompt: "A blue ceramic cup standing still on a white table, gentle camera pan, daylight.", seconds: 4, size: "360p" }, "video"),
    run("vids-audio", "google_vids", "/v1/audio/speech", { model: "gemini-3.8-flash-tts", input: "This is a short local audio smoke test. The connection is working.", voice: "Schedar" }, "audio"),
  ]);
  await Promise.all([1, 2].map(n => run(`auto-parallel-${n}`, undefined, "/v1/chat/completions", text("auto"), "text")));
} finally {
  await save();
  await fetch(new URL(`/api/api-keys/${created.key.id}`, origin), { method: "DELETE" });
  secret = "";
  console.log(JSON.stringify({ report: output, passed: rows.filter(x => x.status === "passed").length, failed: rows.filter(x => x.status === "failed").length, blocked: rows.filter(x => x.status === "blocked").length }));
}
if (rows.some(x => x.status !== "passed")) process.exitCode = 1;
