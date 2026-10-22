import { mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve("src/extension");
await mkdir(resolve(root, "public"), { recursive: true });
await cp(resolve(root, "icons"), resolve(root, "public/icons"), { recursive: true });
