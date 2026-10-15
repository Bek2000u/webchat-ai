import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelType, RequestRecord, SDKRequest } from "../../src/shared/contracts.js";
import { operationStats, statsQuerySchema, STATS_RECORD_LIMIT } from "../../src/server/stats.js";
import { ApiStore } from "../../src/server/storage.js";
import { BrowserDispatcher } from "../../src/server/runtime.js";
import { FileStore } from "../../src/server/files.js";
import { createApp } from "../../src/server/api.js";
import { statsDuration, statsPercent } from "../../src/web/lib/stats.js";

const now = Date.UTC(2026, 9, 15, 12);
const query = statsQuerySchema.parse({});
function record(kind: ModelType, status: RequestRecord["status"], duration = 10000, age = 60000): RequestRecord {
  const options = kind === "text" ? { model: "gemini-web", messages: [{ role: "user", content: "fixture" }] }
    : kind === "image" ? { model: "nano-banana-2.1", prompt: "fixture" }
    : kind === "video" ? { model: "gemini-omni-flash-preview", prompt: "fixture" }
    : { model: "gemini-3.8-flash-tts", text: "fixture", voice: "Schedar" };
  return {
    id: randomUUID(), request: { kind, options } as SDKRequest, status,
    createdAt: new Date(now - age).toISOString(), updatedAt: new Date(now - age + duration).toISOString(), attempts: [],
    ...(status === "error" ? { error: { code: "PROVIDER_UI_ERROR", message: "Fixture only" } } : {}),
  };
}

test("stats count terminal outcomes once and exclude active duration from request end-to-end averages", () => {
  const records = [record("text", "completed", 10000), record("text", "error", 20000), record("image", "completed", 30000), record("video", "running", 40000), record("text", "pending", 50000)];
  const stats = operationStats(records, query, now);
  assert.deepEqual(stats.summary, {
    total: 5, finished: 3, succeeded: 2, failed: 1, pending: 1, running: 1,
    successRate: 2 / 3, averageDurationMs: 20000, durationSamples: 3,
  });
  assert.deepEqual(stats.operations.find((value) => value.operation === "text"), {
    operation: "text", total: 3, finished: 2, succeeded: 1, failed: 1, pending: 1, running: 0,
    successRate: 0.5, averageDurationMs: 15000, durationSamples: 2,
  });
  assert.equal(stats.operations.find((value) => value.operation === "video")?.averageDurationMs, null);
  assert.deepEqual(stats.errors, [{ key: "PROVIDER_UI_ERROR", count: 1, total: 3, errorRate: 1 / 3 }]);
});

test("stats window is created-at based, bounded inclusively and excludes future requests", () => {
  const sixHours = 6 * 3600000;
  const records = [record("text", "completed", 1, sixHours), record("text", "completed", 1, sixHours + 1), record("text", "completed", 0, 0), record("text", "completed", 1, -1)];
  assert.equal(operationStats(records, query, now).summary.total, 2);
  assert.equal(operationStats(records, { ...query, window: "24h" }, now).summary.total, 3);
  assert.equal(operationStats(records, { ...query, window: "7d" }, now).summary.total, 3);
});

test("auto attribution uses its final attempt provider and resolved model, not the requested alias", () => {
  const completed = record("text", "completed", 90000, 100000), failed = record("text", "error", 80000, 100000);
  for (const item of [completed, failed]) {
    item.request.options.model = "auto";
    item.attempts = [
      { number: 1, model: "gemini-web", provider: "gemini_web", profileId: "one", startedAt: item.createdAt, durationMs: 10000, decision: "retry" },
      { number: 2, model: "qwen-web", provider: "qwen_web", profileId: "two", startedAt: item.createdAt, durationMs: 20000, decision: item.status === "error" ? "failed" : "completed" },
    ];
  }
  const qwen = operationStats([completed, failed], { ...query, provider: "qwen_web", groupBy: "model" }, now);
  assert.equal(qwen.summary.total, 2);
  assert.equal(qwen.summary.finished, 2);
  assert.equal(qwen.summary.averageDurationMs, 85000);
  assert.deepEqual(qwen.errors, [{ key: "qwen-web", count: 1, total: 2, errorRate: 0.5 }]);
  assert.equal(operationStats([completed, failed], { ...query, provider: "gemini_web" }, now).summary.total, 0);
});

test("error percentages use terminal model/operation denominators and never pending requests", () => {
  const records = [record("text", "completed"), record("text", "error"), record("text", "pending"), record("image", "error")];
  const byModel = operationStats(records, { ...query, groupBy: "model" }, now);
  assert.deepEqual(byModel.errors.find((value) => value.key === "gemini-web"), { key: "gemini-web", count: 1, total: 2, errorRate: 0.5 });
  const byOperation = operationStats(records, { ...query, groupBy: "operation" }, now);
  assert.deepEqual(byOperation.errors.find((value) => value.key === "image"), { key: "image", count: 1, total: 1, errorRate: 1 });
});

test("missing timing remains unknown and journal coverage honestly signals the record limit", () => {
  const broken = record("audio", "error"), backwards = record("text", "completed");
  broken.updatedAt = "not a timestamp";
  backwards.updatedAt = new Date(Date.parse(backwards.createdAt) - 1).toISOString();
  const stats = operationStats([broken, backwards], query, now, 2);
  assert.equal(stats.summary.finished, 2);
  assert.equal(stats.summary.averageDurationMs, null);
  assert.equal(stats.summary.durationSamples, 0);
  assert.equal(stats.coverage.limitReached, true);
  assert.equal(stats.coverage.scanned, 2);
  assert.equal(stats.coverage.oldestCreatedAt, broken.createdAt);
  assert.equal(stats.coverage.timeBasis, "created_at");
  assert.equal(operationStats([], query, now).summary.successRate, null);
  assert.equal(statsDuration(null), "—");
  assert.equal(statsDuration(0), "0 с");
  assert.equal(statsPercent(null), "—");
  assert.equal(statsPercent(0), "0 %");
});

test("stats HTTP aggregates the bounded full journal rather than the UI's latest 100 jobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webchat-ai-stats-"));
  const store = await ApiStore.open({ path: ":memory:" });
  const host = new BrowserDispatcher(store, []);
  try {
    for (let index = 0; index < 150; index++) {
      const item = store.createRequest(record("text", "completed").request);
      if (index < 100) {
        store.startRequest(item.id, "fixture-profile");
        store.completeRequest(item.id, { text: "Fixture only", chunks: [] });
      } else store.failRequest(item.id, { code: "PROVIDER_UI_ERROR", message: "Fixture only" });
    }
    let scannedLimit = 0;
    const originalList = store.listRequests.bind(store);
    store.listRequests = (limit) => { scannedLimit = limit ?? 0; return originalList(limit); };
    const app = createApp({ store, host, files: new FileStore(store.db, join(dir, "files")), config: { dataDir: dir } });
    const response = await app.request("/api/stats/operations?window=24h&provider=gemini_web&groupBy=operation");
    assert.equal(response.status, 200);
    const stats = await response.json();
    assert.equal(scannedLimit, STATS_RECORD_LIMIT);
    assert.equal(stats.summary.total, 150);
    assert.equal(stats.summary.succeeded, 100);
    assert.equal(stats.summary.failed, 50);
    assert.equal(stats.coverage.scanned, 150);
    assert.equal(stats.coverage.limitReached, false);
    for (const query of ["window=1h", "provider=unknown", "groupBy=price"]) assert.equal((await app.request("/api/stats/operations?" + query)).status, 400);
    assert.equal((await app.request("/api/stats/operations", { headers: { Origin: "https://evil.test" } })).status, 403);
  } finally {
    await host.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
