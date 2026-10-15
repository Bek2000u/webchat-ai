import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import { appRoutes } from "../../routes.js";
import { cn } from "../../lib/utils.js";

type Props = { collapsed: boolean; onCollapse(): void; open: boolean; onClose(): void };
export function Sidebar({ collapsed, onCollapse, open, onClose }: Props) {
  return <>
    {open && <button className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={onClose} aria-label="Закрыть меню" />}
    <aside className={cn("border-r border-sidebar-border bg-sidebar text-sidebar-foreground z-50 flex shrink-0 flex-col fixed inset-y-0 left-0 md:static md:translate-x-0 transition-[width,transform] duration-200", collapsed ? "md:w-[72px] w-64" : "w-60", open ? "translate-x-0" : "-translate-x-full")}>
      <div className="flex h-12 justify-end px-3 md:hidden"><button onClick={onClose} aria-label="Закрыть меню"><X className="size-5" /></button></div>
      <nav aria-label="Основная навигация" className="flex-1 space-y-1 overflow-y-auto px-3 py-5">
        {appRoutes.map(item => <NavLink key={item.path} to={item.path} onClick={onClose}
          title={collapsed ? item.label : undefined} aria-label={item.label}
          className={({isActive}) => cn("flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors", collapsed && "md:justify-center md:px-0", isActive ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")}>
          <item.icon className="size-5 shrink-0" aria-hidden="true" />
          <span className={cn(collapsed && "md:sr-only")}>{item.label}</span>
        </NavLink>)}
      </nav>
      <div className="mx-4 border-t border-border" />
      <div className="flex flex-col gap-1 p-3">
        <button className="hidden min-h-10 items-center rounded-lg hover:bg-sidebar-accent md:flex justify-center" onClick={onCollapse} aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"} aria-expanded={!collapsed}>
          {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
        </button>
      </div>
    </aside>
  </>;
}
