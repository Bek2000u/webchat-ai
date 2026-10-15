function connectionLabel(runtime) {
  if (runtime.enabled === false) return "○ Выключен";
  if (runtime.connected) return "● Подключён";
  if (!runtime.client_paired) return "○ Аккаунт не подтверждён";
  if (runtime.registration_paused) return "◑ Требуется проверка";
  if (runtime.registered) return "◐ Переподключение";
  return "○ Ожидает входа";
}

export function formatRuntimeStatus(runtime) {
  const identity = runtime.account_email
    || "аккаунт не определён";
  const totals = `${runtime.completed_requests || 0} выполнено`;
  const failures = runtime.error_count ? ` · ${runtime.error_count} ошибок` : "";
  return [
    `${connectionLabel(runtime)} · ${identity}`,
    `${(runtime.capabilities || []).join(" · ") || "нет доступных операций"}`,
    `${totals}${failures}`,
    runtime.enabled !== false && runtime.last_error ? `Ошибка: ${runtime.last_error}` : ""
  ].filter(Boolean).join("\n");
}
