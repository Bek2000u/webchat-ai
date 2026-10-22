import { createContext, type ReactNode, useContext } from "react";
import { useAppData, type AppData } from "./hooks/useAppData.js";

const AppContext = createContext<AppData | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const value = useAppData();
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppDataContext() {
  const value = useContext(AppContext);
  if (!value) throw new Error("useAppDataContext must be used inside AppProvider");
  return value;
}
