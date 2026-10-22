import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBuild } from "./check-build.mjs";

const mode = process.argv[2] || "desktop";
if (!["desktop", "server", "dev"].includes(mode))
  throw new Error("Extension build mode must be desktop, server or dev");
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../node_modules/wxt/bin/wxt.mjs", import.meta.url));
const args = [cli, "build", "src/extension", ...(mode === "dev" ? ["--mode", "development"] : [])];
const child = spawn(process.execPath, args, {
  cwd: root,
  env: { ...process.env, WXT_COMPANION_MODE: mode === "server" ? "server" : "desktop" },
  stdio: "inherit",
});
const stop = () => child.kill();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode) => resolve(exitCode ?? 1));
});
process.removeListener("SIGINT", stop);
process.removeListener("SIGTERM", stop);
if (code !== 0) process.exitCode = code;
else {
  const output = mode === "dev" ? "extension-dev/chrome-mv3-dev" : mode === "server" ? "extension-server/chrome-mv3" : "extension/chrome-mv3";
  const count = await checkBuild(fileURLToPath(new URL(`../../dist/${output}/`, import.meta.url)));
  console.log(`Packaged ${mode} extension: ${count} manifest resources verified`);
}
