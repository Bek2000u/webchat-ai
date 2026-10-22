import { Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { i18n } from "./i18n.js";
import { AppProvider } from "./AppContext.js";
import { AppLayout } from "./components/layout/AppLayout.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { RequestsPage } from "./pages/RequestsPage.js";
import { PlaygroundPage } from "./pages/PlaygroundPage.js";
import { AccountsPage } from "./pages/AccountsPage.js";
import { ProvidersPage } from "./pages/ProvidersPage.js";
import { ApiKeysPage } from "./pages/ApiKeysPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { StatsPage } from "./pages/StatsPage.js";

function LocalApp() {
  return (
    <AppProvider>
      <AppLayout />
    </AppProvider>
  );
}

export function App() {
  useTranslation(undefined, { i18n });
  return (
    <Routes>
      <Route element={<LocalApp />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/accounts" element={<AccountsPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/api-keys" element={<ApiKeysPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/generator" element={<PlaygroundPage />} />
        <Route path="/playground" element={<Navigate to="/generator" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
