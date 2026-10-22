import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Validate the packaged manifest, not just the source/bundler entrypoints. */
export async function checkBuild(directory) {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  const files = new Set();
  const add = value => { if (typeof value === "string") files.add(value); };
  const icons = value => { if (typeof value === "string") add(value); else Object.values(value || {}).forEach(add); };
  add(manifest.background?.service_worker);
  (manifest.background?.scripts || []).forEach(add);
  add(manifest.options_page); add(manifest.options_ui?.page);
  add(manifest.action?.default_popup); icons(manifest.action?.default_icon);
  icons(manifest.icons);
  if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
  Object.values(manifest.chrome_url_overrides || {}).forEach(add);
  for (const content of manifest.content_scripts || []) {
    (content.js || []).forEach(add); (content.css || []).forEach(add);
  }
  for (const file of files) {
    const path = resolve(root, file);
    if (!path.startsWith(root + sep)) throw Error(`Manifest resource escapes build directory: ${file}`);
    if (!(await stat(path).catch(() => null))?.isFile()) throw Error(`Manifest references missing file: ${file}`);
  }
  return files.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const count = await checkBuild(process.argv[2]);
  console.log(`Packaged extension manifest: ${count} referenced files exist`);
}
