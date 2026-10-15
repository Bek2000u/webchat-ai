import {
  LayoutDashboard,
  ListChecks,
  CircleUserRound,
  KeyRound,
  Play,
  Settings,
  Blocks,
  ChartNoAxesCombined,
  type LucideIcon,
} from "lucide-react";

export type AppRoute = {
  path: string;
  label: string;
  icon: LucideIcon;
};

export const appRoutes: AppRoute[] = [
  { path: "/dashboard", label: "Обзор", icon: LayoutDashboard },
  { path: "/stats", label: "Статистика", icon: ChartNoAxesCombined },
  { path: "/accounts", label: "Профили Chrome", icon: CircleUserRound },
  { path: "/providers", label: "Провайдеры", icon: Blocks },
  { path: "/api-keys", label: "API-ключи", icon: KeyRound },
  { path: "/requests", label: "Запросы", icon: ListChecks },
  { path: "/generator", label: "Генератор", icon: Play },
  { path: "/settings", label: "Настройки", icon: Settings }
];

export function routeTitle(pathname: string) {
  return appRoutes.find((route) => route.path === pathname)?.label ?? "WebChat AI";
}
