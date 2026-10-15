import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useAppDataContext } from "../../AppContext.js";
import { routeTitle } from "../../routes.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Skeleton } from "../ui/skeleton.js";
import { Header } from "./Header.js";
import { Sidebar } from "./Sidebar.js";

export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("chat2api-sidebar-collapsed") === "true");
  const location = useLocation(), data = useAppDataContext();
  const hasData = data.models.length > 0 || data.jobs.length > 0 || data.workers.length > 0;
  return <div className="relative flex h-svh flex-col overflow-hidden bg-background">
    <Header loading={data.loading} failed={Boolean(data.error)} onMenu={() => setSidebarOpen(true)} onReload={() => void data.reload()} />
    <div className="relative flex min-h-0 flex-1">
      <Sidebar collapsed={collapsed} onCollapse={() => setCollapsed(value => { localStorage.setItem("chat2api-sidebar-collapsed", String(!value)); return !value; })} open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <main className="shell-content min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
          <div><h1 className="shell-title">{routeTitle(location.pathname)}</h1><p className="mt-1 text-sm text-muted-foreground">Локальный API · генерация в вашем Chrome</p></div>
          {data.error && <Alert variant="destructive"><AlertDescription>{data.error}</AlertDescription></Alert>}
          {data.loading && !hasData ? <div className="flex flex-col gap-4"><Skeleton className="h-24 rounded-xl" /><Skeleton className="h-64 rounded-xl" /></div> : <Outlet />}
        </div>
      </main>
    </div>
  </div>;
}
