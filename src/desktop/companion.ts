import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

type Manifest = { version: string; key: string };

async function manifest(directory: string): Promise<Manifest> {
  const value = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (!value.version || !value.key) throw Error("Invalid bundled companion manifest");
  return { version: value.version, key: value.key };
}

async function bundleHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error("Companion bundle must not contain symbolic links");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { hash.update(relative(root, path)); hash.update("\0"); hash.update(await readFile(path)); }
    }
  }
  await visit(root);
  return hash.digest("hex");
}

/** Chrome keeps this path and the manifest key across application installations. */
export async function syncDesktopCompanion(source: string, dataDirectory: string): Promise<{ extensionDir: string; extensionVersion: string; extensionDirectoryUpdated: boolean }> {
  const extensionDir = join(resolve(dataDirectory), "extension");
  if (resolve(source) === extensionDir) throw Error("Companion source cannot be its installed directory");
  const bundled = await manifest(source);
  const hash = await bundleHash(source);
  let installed: Manifest | undefined;
  try { installed = await manifest(extensionDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (installed && installed.key !== bundled.key) throw Error("Companion identity changed; existing installation preserved");
  if (installed) {
    const oldHash = await readFile(join(extensionDir, ".bundle.sha256"), "utf8").catch(() => "");
    if (oldHash === hash) return { extensionDir, extensionVersion: bundled.version, extensionDirectoryUpdated: false };
  }

  // Only these managed asset folders are replaced; browser/profile storage is external.
  const stage = join(resolve(dataDirectory), "extension.next");
  const previous = join(resolve(dataDirectory), "extension.previous");
  await mkdir(dataDirectory, { recursive: true });
  await rm(stage, { recursive: true, force: true });
  await cp(source, stage, { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(stage, ".bundle.sha256"), hash, "utf8");
  if (installed) { await rm(previous, { recursive: true, force: true }); await rename(extensionDir, previous); }
  try { await rename(stage, extensionDir); }
  catch (error) { if (installed) await rename(previous, extensionDir); throw error; }
  return { extensionDir, extensionVersion: bundled.version, extensionDirectoryUpdated: true };
}
