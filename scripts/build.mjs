import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

const target = process.argv[2];
await mkdir("dist", { recursive: true });
const node = { bundle: true, platform: "node", target: "node24", sourcemap: true };
if (target === "server") {
  await build({ ...node, entryPoints: ["src/server/index.ts"], outfile: "dist/server/index.mjs", format: "esm",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
} else if (target === "desktop") {
  await build({ ...node, entryPoints: ["src/desktop/main.ts"], outfile: "dist/desktop/main.cjs", format: "cjs", external: ["electron", "electron-updater"] });
  await build({ ...node, entryPoints: ["src/desktop/preload.ts"], outfile: "dist/desktop/preload.cjs", format: "cjs", external: ["electron"] });
} else throw Error("Choose server or desktop");
