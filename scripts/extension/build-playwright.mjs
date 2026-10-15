import { build, transform } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  injectedEngineKey,
  injectedEngineOptions,
} from "../../src/extension/playwright/injected.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = resolve(root, "src/extension/playwright");
const project = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const pinnedVersion = project.devDependencies["playwright-core"];
const core = JSON.parse(
  await readFile(
    new URL(import.meta.resolve("playwright-core/package.json")),
    "utf8",
  ),
);
if (core.version !== pinnedVersion)
  throw Error(
    `Playwright version mismatch: ${core.version} != ${pinnedVersion}`,
  );

const coreBundlePath = fileURLToPath(
  import.meta.resolve("playwright-core/lib/coreBundle"),
);
const coreBundle = await readFile(coreBundlePath, "utf8");
const sourceMarker = "source5 = ";
const markerIndex = coreBundle.indexOf(sourceMarker);
if (
  markerIndex < 0 ||
  coreBundle.indexOf(sourceMarker, markerIndex + sourceMarker.length) >= 0
)
  throw Error(
    "Could not identify Playwright's generated injected script in coreBundle.js",
  );
const literalStart = markerIndex + sourceMarker.length;
if (coreBundle[literalStart] !== "'")
  throw Error("Playwright's generated injected script format changed");
let literalEnd = literalStart + 1;
for (; literalEnd < coreBundle.length; literalEnd++) {
  if (coreBundle[literalEnd] === "\\") {
    literalEnd++;
    continue;
  }
  if (coreBundle[literalEnd] === "'") break;
}
if (literalEnd >= coreBundle.length)
  throw Error("Playwright's generated injected script string is unterminated");
const injectedScriptSource = Function(
  `return ${coreBundle.slice(literalStart, literalEnd + 1)}`,
)();
if (
  typeof injectedScriptSource !== "string" ||
  !injectedScriptSource.includes("InjectedScript")
)
  throw Error("Playwright's generated injected script is invalid");
const injectedBootstrap = `(() => { const module = { exports: {} }; const exports = module.exports; ${injectedScriptSource}; const key = Symbol.for(${JSON.stringify(injectedEngineKey)}); globalThis[key] ??= new (module.exports.InjectedScript())(window, ${JSON.stringify(injectedEngineOptions)}); })();`;
const injected = await transform(injectedBootstrap, {
  loader: "js",
  target: "chrome116",
  minify: true,
});
await build({
  entryPoints: [resolve(sourceDir, "index.ts")],
  outdir: resolve(root, "dist/playwright"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome116",
  sourcemap: true,
  plugins: [
    {
      name: "crx-injected",
      setup(b) {
        b.onResolve({ filter: /injected-source\.js$/ }, () => ({
          path: "injected",
          namespace: "crx",
        }));
        b.onLoad({ filter: /.*/, namespace: "crx" }, () => ({
          contents: `export const source = ${JSON.stringify(injected.code)}; export const version = ${JSON.stringify(core.version)};`,
        }));
      },
    },
  ],
});
console.log(
  `Playwright Chromium DOM engine ${core.version}: ${Buffer.byteLength(injected.code)} bytes`,
);
// Source-mode tests use the same generated payload as the packaged runtime.
await writeFile(
  resolve(root, "dist/playwright/injected-source.d.ts"),
  "export declare const source: string;\nexport declare const version: string;\n",
);
await writeFile(
  resolve(root, "dist/playwright/injected-source.js"),
  `export const source = ${JSON.stringify(injected.code)}; export const version = ${JSON.stringify(core.version)};\n`,
);
