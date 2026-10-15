import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src/web", import.meta.url)) } },
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8000", "/v1": "http://127.0.0.1:8000" } },
});
