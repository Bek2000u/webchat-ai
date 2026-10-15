import { type Account, type ProviderWorker } from "../../shared/contracts.js";

const providerIds = ["gemini_web", "flow", "google_vids", "qwen_web", "deepseek_web", "chatgpt_web"];

const emails = [
  "chrome.main@gmail.com",
  "studio.team@gmail.com",
  "flow.production@gmail.com",
  "video.lab@gmail.com",
  "content.ops@gmail.com",
  "creative.one@gmail.com",
  "automation.dev@gmail.com",
  "media.queue@gmail.com",
  "render.team@gmail.com",
  "backup.profile@gmail.com"
];

const firstProfileStatuses = ["ready", "busy", "error", "offline", "ready", "ready"];

function demoWorker(accountId: string, profileIndex: number, providerId: string, providerIndex: number): ProviderWorker {
  const status = profileIndex === 0
    ? firstProfileStatuses[providerIndex]
    : ["ready", "ready", "busy", "ready", "offline", "error"][(profileIndex + providerIndex) % 6];
  const enabled = status !== "offline";

  return {
    id: `demo-worker-${profileIndex + 1}-${providerId}`,
    account_id: accountId,
    provider_id: providerId,
    account_subject: providerId === "qwen_web" || providerId === "deepseek_web" ? `${providerId}:demo-${profileIndex + 1}` : emails[profileIndex],
    online: enabled,
    enabled,
    active_jobs: status === "busy" ? 1 + (profileIndex % 2) : 0,
    queued_jobs: (profileIndex + providerIndex) % 4 === 0 ? 2 : (profileIndex + providerIndex) % 3 === 0 ? 1 : 0,
    status,
    last_seen_at: new Date(Date.now() - (profileIndex * 3 + providerIndex) * 60_000).toISOString(),
    driver_version: "1.0.0-demo",
    capabilities: [],
    account_status: providerId === "gemini_web" || providerId === "flow"
      ? { subscription_plan: "Pro", credits_remaining: 84, credits_total: 100 }
      : {}
  };
}

export function createDemoAccounts(): Account[] {
  return emails.map((accountEmail, profileIndex) => {
    const accountId = `demo-account-${String(profileIndex + 1).padStart(2, "0")}`;
    return {
      id: accountId,
      label: `Chrome ${profileIndex + 1}`,
      chrome_email: accountEmail,
      enabled: true,
      created_at: new Date(Date.now() - profileIndex * 86_400_000).toISOString(),
      providers: providerIds.map((providerId, providerIndex) =>
        demoWorker(accountId, profileIndex, providerId, providerIndex)
      )
    };
  });
}

export function isDemoAccountId(accountId: string) {
  return accountId.startsWith("demo-account-");
}

export function isDemoWorkerId(workerId: string) {
  return workerId.startsWith("demo-worker-");
}
