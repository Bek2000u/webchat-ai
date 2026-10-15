import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.js";
import { initializeTheme, ThemeProvider } from "./ThemeProvider.js";
import { Toaster } from "./components/ui/sonner.js";
import { TooltipProvider } from "./components/ui/tooltip.js";
import "./index.css";

initializeTheme();

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <TooltipProvider>
          <App />
          <Toaster richColors position="bottom-right" />
        </TooltipProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
