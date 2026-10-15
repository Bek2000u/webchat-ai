import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Account, JobRow, ProviderWorker } from "../../src/shared/contracts.js";
import { createDemoAccounts } from "../../src/web/lib/demo-accounts.js";
import { matchesSlot, pendingCounts, profileLabel, providerSlots, slotIdentity, workerAvailable } from "../../src/web/lib/provider-tables.js";
import { ProviderProfilesTable } from "../../src/web/components/providers/ProviderProfilesTable.js";

function job(id: string, model: string, status = "queued", provider_id = ""): JobRow {
  return { id, request_id: id, model, status, provider_id, broker_status: status, error_details: {},
    output_count: 0, created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z" } as JobRow;
}
test("queue counts pending request IDs once and keeps auto separate from prior provider", () => {
  const image = job("image", "nano-banana-2-lite", "queued", "flow");
  assert.deepEqual(pendingCounts([image, image, job("other", "nano-banana-2-lite"),
    job("auto", "auto", "queued", "gemini_web"), job("done", "gemini-web", "succeeded")]),
  { providers: { flow: 2 }, auto: 1 });
});
test("same email in different Chrome profiles remains distinct provider slots", () => {
  const profiles = createDemoAccounts().slice(0, 2);
  profiles[1].chrome_email = profiles[0].chrome_email;
  profiles[1].providers[0].account_subject = profiles[0].providers[0].account_subject;
  const slots = providerSlots(profiles);
  assert.equal(slots.length, 12);
  assert.notEqual(slots[0].worker.id, slots[6].worker.id);
  assert.notEqual(slots[0].profile.id, slots[6].profile.id);
});
test("site identity never falls back to a Chrome email", () => {
  const profile = createDemoAccounts()[0];
  const slot = { profile, worker: { ...profile.providers[0], account_subject: undefined } };
  assert.equal(slotIdentity(slot), "Не определён");
  assert.equal(matchesSlot({ profile, worker: profile.providers[0] }, "CHROME.MAIN"), true);
  assert.equal(matchesSlot({ profile, worker: profile.providers[0] }, "missing"), false);
});
test("profile labels use label or short profile ID, not a website identity", () => {
  assert.equal(profileLabel({ id: "profile-123456", label: "profile-123456" } as Account), "Профиль 123456");
  assert.equal(profileLabel({ id: "id", label: "Работа" } as Account), "Работа");
});
test("observed failure does not make an available connection offline", () => {
  const worker = { enabled: true, online: true, status: "ready", health: {
    lastError: { model: "gemini-web", at: "2026-10-15T00:00:00Z", error: { code: "CAPACITY", message: "Capacity" } },
  } } as ProviderWorker;
  assert.equal(workerAvailable(worker), true);
  assert.equal(workerAvailable({ ...worker, enabled: false }), false);
  assert.equal(workerAvailable({ ...worker, status: "error" }), false);
  assert.equal(workerAvailable({ ...worker, online: false }), false);
  assert.equal(workerAvailable({ ...worker, status: "busy" }), true);
});
function markup(profiles: Account[]) {
  return renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ProviderProfilesTable,
    { slots: providerSlots(profiles), busy: new Set<string>(), onToggle: async () => {} })));
}
test("shared provider table exposes connection separately from observed failure and no profile queue", () => {
  const profile = createDemoAccounts()[0];
  profile.providers = [{ ...profile.providers[0], enabled: true, online: true, status: "ready", queued_jobs: 999,
    health: { lastError: { model: "gemini-web", at: "2026-10-15T00:00:00Z", error: { code: "CAPACITY", message: "Capacity" } } } }];
  const html = markup([profile]);
  assert.match(html, /<table/);
  assert.match(html, /Аккаунт сайта/);
  assert.match(html, /Готов/);
  assert.match(html, /Последний результат/);
  assert.match(html, /Последняя ошибка: Capacity/);
  assert.doesNotMatch(html, /999|В очереди/);
  assert.match(html, /requests\?provider=gemini_web&amp;account=/);
});
test("Vids free access failure and account identity survive the shared table", () => {
  const profile = createDemoAccounts()[0];
  profile.providers = [{ ...profile.providers[2], enabled: true, online: true, status: "error",
    account_status: { account_tier: "free" }, connection_error: { code: "GOOGLE_VIDS_PAID_PLAN_REQUIRED", message: "Unlimited required", provider: "google_vids", stage: "account" } }];
  const html = markup([profile]);
  assert.match(html, /Нужен Paid с безлимитной озвучкой/);
  assert.match(html, /Ограниченные кредиты/);
  assert.match(html, /chrome.main@gmail.com/);
  assert.match(html, /Free/);
});
