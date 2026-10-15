import { defineConfig } from "wxt";
import { readFileSync } from "node:fs";
import {
  normalizeServerOrigin,
  serverPermissionOrigin,
} from "./runtime/origin.js";

const dev = process.argv.includes("development");
const base = JSON.parse(
  readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);
const overlay = dev
  ? {
      name: "WebChat AI Companion Dev",
      version_name: `${base.version}-dev`,
      description: "Isolated local companion for real provider driver testing.",
      key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt+s/kfWARWxW6U2fJT//lbmGUoAhA0kyVRHv16C9iC9ypxpuRfcHTaTw+Kd2FQtMRG7B8Dvqg5ayLPMqPYwfg3iUPejb0ZYGj4Mj9W+KmCaAmwqFy4+S/fqLHfnw91cU0+VbxGqxIz9DzUF7eiZ75UF+KCgHsRzCcAsJORDYWHcaTbJ/F3E4kndhuspnP/jFNCEpHCiFeUKYQbdyScB6LDGHRxcZ2YKlYhqcdB9727whDIhS13tviLFJ+WPcZC+V1M7+rqereXY+xlfaArI5Q5yuihbFd+zyA/q0djVULgVC1kmhbhIlzNVV+AFiA1sAgSJ+PX/qbHg15GFBcKHVHQIDAQAB",
    }
  : {};
const origin = normalizeServerOrigin(
  process.env.SERVER_ORIGIN ||
    process.env.WXT_SERVER_ORIGIN ||
    "http://127.0.0.1:8001",
);
const {
  background: _background,
  options_page: _options,
  manifest_version: _manifestVersion,
  action,
  ...manifest
} = { ...base, ...overlay };
export default defineConfig({
  manifestVersion: 3,
  outDir: dev ? "../../dist/extension-dev" : "../../dist/extension",
  manifest: {
    ...manifest,
    action: { ...action, default_popup: "options.html" },
    optional_host_permissions: ["http://*/*", "https://*/*"],
    host_permissions: [
      ...base.host_permissions.filter(
        (host: string) => host !== "http://127.0.0.1/*",
      ),
      serverPermissionOrigin(origin),
    ],
  },
  vite: () => ({
    define: {
      __BUILT_SERVER_ORIGIN__: JSON.stringify(origin),
      __DEV_COMPANION__: JSON.stringify(dev),
    },
    build: { target: "chrome116" },
  }),
});
