import { apiGet, apiSend } from "./client.js";
import {
  type Account,
  type ApiKeyRecord,
  type BrokerJobStatus,
  type CreatedApiKey,
  type DashboardStats,
  type JobDetail,
  type JobRow,
  type JobStatus,
  type ModelCapabilities,
  type ModelEntry,
  type ModelType,
  type ProviderWorker,
  type ServerConfig,
  type SystemInfoResponse,
  type ApiResponses,
  type VideoForgeConnectorState,
} from "../../shared/contracts.js";

export async function getModels() {
  return (await apiGet<ApiResponses["models"]>("/api/models")).models;
}

export function getJobs(limit = 100, status?: BrokerJobStatus) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (status) query.set("status", status);
  return apiGet<JobRow[]>(`/api/jobs?${query.toString()}`);
}

export function getJobDetail(jobId: string) {
  return apiGet<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function getAccounts() {
  return apiGet<Account[]>("/api/accounts");
}

export function setProviderWorkerEnabled(workerId: string, enabled: boolean) {
  return apiSend<ProviderWorker>(
    `/api/provider-workers/${encodeURIComponent(workerId)}`,
    "PATCH",
    { enabled }
  );
}

export function revokeAccount(accountId: string) {
  return apiSend<{ success: boolean }>(
    `/api/accounts/${encodeURIComponent(accountId)}`,
    "DELETE"
  );
}

export function getServerConfig() {
  return apiGet<ServerConfig>("/api/config");
}

export function saveServerConfig(textProviderOrder: string[]) {
  return apiSend<ServerConfig>("/api/config", "PATCH", { textProviderOrder });
}

export function getVideoForgeConnector() {
  return apiGet<VideoForgeConnectorState>("/api/videoforge/connector");
}

export function saveVideoForgeConnector(input: { origin: string; token?: string; enabled: boolean }) {
  return apiSend<VideoForgeConnectorState>("/api/videoforge/connector", "PUT", input);
}

export function getDashboardStats() {
  return apiGet<DashboardStats>("/api/stats");
}

export function getSystemInfo() {
  return apiGet<SystemInfoResponse>("/api/system/info");
}

export function getApiKeys() {
  return apiGet<ApiKeyRecord[]>("/api/api-keys");
}

export function createApiKey(label: string) {
  return apiSend<CreatedApiKey>("/api/api-keys", "POST", { label });
}

export function setApiKeyEnabled(keyId: string, enabled: boolean) {
  return apiSend<ApiKeyRecord>(`/api/api-keys/${encodeURIComponent(keyId)}`, "PATCH", { enabled });
}

export function deleteApiKey(keyId: string) {
  return apiSend<{ id: string; success: boolean }>(
    `/api/api-keys/${encodeURIComponent(keyId)}`,
    "DELETE"
  );
}
