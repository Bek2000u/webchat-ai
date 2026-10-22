import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_TEXT_ROUTES, modelSpec } from "../shared/models.js";

export const textProviderOrderSchema = z.array(z.string())
  .min(1, "Text provider order must not be empty")
  .refine((ids) => ids.every((id) => modelSpec(id)?.providerId && modelSpec(id)?.kind === "text"),
    "Text provider order must contain concrete text model IDs")
  .transform((ids) => [...new Set(ids)]);

export const settingsSchema = z.object({ textProviderOrder: textProviderOrderSchema }).strict();
export type Settings = z.infer<typeof settingsSchema>;

export async function loadSettings(dataDir: string, initialOrder?: readonly string[]): Promise<Settings> {
  let content: string;
  try {
    content = await readFile(join(dataDir, "settings.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return settingsSchema.parse({ textProviderOrder: initialOrder ?? DEFAULT_TEXT_ROUTES });
  }
  return settingsSchema.parse(JSON.parse(content));
}

export async function saveSettings(dataDir: string, value: Settings): Promise<void> {
  const settings = settingsSchema.parse(value);
  await mkdir(dataDir, { recursive: true });
  const temporary = join(dataDir, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, join(dataDir, "settings.json"));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
