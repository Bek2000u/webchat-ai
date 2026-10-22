import { t, localeTag } from "../i18n.js";
import { useCallback, useEffect, useState } from "react";
import {
  getApiKeys,
  getDashboardStats,
  getJobs,
  getModels,
  getAccounts,
  getServerConfig,
  getSystemInfo,
} from "../api/app.js";
import {
  type ApiKeyRecord,
  type DashboardStats,
  type Account,
  type JobRow,
  type ModelEntry,
  type ServerConfig,
  type SystemInfo,
} from "../../shared/contracts.js";

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : t("Не удалось загрузить данные");
}

export function useAppData() {
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const handleError = useCallback((reason: unknown) => {
    setError(errorMessage(reason));
  }, []);

  const reloadStatus = useCallback(async () => {
    const [modelsResult, accountsResult, statsResult, jobsResult] = await Promise.allSettled([
      getModels(),
      getAccounts(),
      getDashboardStats(),
      getJobs()
    ]);
    if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
    if (accountsResult.status === "fulfilled") setAccounts(accountsResult.value);
    if (statsResult.status === "fulfilled") setStats(statsResult.value);
    if (jobsResult.status === "fulfilled") setJobs(jobsResult.value);
    const failed = [modelsResult, accountsResult, statsResult, jobsResult]
      .find((result) => result.status === "rejected");
    if (failed?.status === "rejected") handleError(failed.reason);
  }, [handleError]);

  const reloadApiKeys = useCallback(async () => {
    const [keysResult, configResult, systemResult] = await Promise.allSettled([
      getApiKeys(),
      getServerConfig(),
      getSystemInfo()
    ]);
    if (keysResult.status === "fulfilled") setApiKeys(keysResult.value);
    if (configResult.status === "fulfilled") setServerConfig(configResult.value);
    if (systemResult.status === "fulfilled") setSystemInfo(systemResult.value.info);
    const failed = [keysResult, configResult, systemResult].find((result) => result.status === "rejected");
    if (failed?.status === "rejected") handleError(failed.reason);
  }, [handleError]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    const results = await Promise.allSettled([
      getModels(),
      getJobs(),
      getAccounts(),
      getServerConfig(),
      getDashboardStats(),
      getSystemInfo(),
      getApiKeys()
    ]);
    const [modelsResult, jobsResult, accountsResult, configResult, statsResult, systemResult, keysResult] = results;

    if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
    if (jobsResult.status === "fulfilled") setJobs(jobsResult.value);
    if (accountsResult.status === "fulfilled") setAccounts(accountsResult.value);
    if (configResult.status === "fulfilled") setServerConfig(configResult.value);
    if (statsResult.status === "fulfilled") setStats(statsResult.value);
    if (systemResult.status === "fulfilled") setSystemInfo(systemResult.value.info);
    if (keysResult.status === "fulfilled") setApiKeys(keysResult.value);

    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") handleError(failed.reason);
    setLoading(false);
  }, [handleError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => void reloadStatus(), 3_000);
    return () => window.clearInterval(timer);
  }, [reloadStatus]);

  const workers = accounts.flatMap((account) => account.providers);

  return {
    error,
    loading,
    apiKeys,
    jobs,
    models,
    accounts,
    serverConfig,
    stats,
    systemInfo,
    workers,
    reload,
    reloadApiKeys,
    reloadStatus
  };
}

export type AppData = ReturnType<typeof useAppData>;
