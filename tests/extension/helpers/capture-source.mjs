import { readFile } from "node:fs/promises";
import ts from "typescript";
/** Exercise the actual TS page entry in the existing isolated MAIN-world fixtures. */
export async function captureSource(name) {
  const source = await readFile(new URL(`../../../src/extension/entrypoints/${name}.ts`, import.meta.url), "utf8");
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import .*defineUnlistedScript.*;\r?\n/m, "")
    .replace("export default defineUnlistedScript(", "(")
    .replace(/\);\s*$/, ")();\n");
}
