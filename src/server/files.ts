import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { type SqliteApi } from "@workglow/sqlite/storage";
import { ServiceError } from "./errors.js";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export interface StoredFile {
  id: string;
  requestId: string;
  path: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}
export class FileStore {
  constructor(
    readonly db: SqliteApi.Database,
    readonly root: string,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,path TEXT NOT NULL,mime_type TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL)",
    );
  }
  get(id: string): StoredFile | undefined {
    const row = this.db
      .prepare<[string], Record<string, unknown>>(
        "SELECT * FROM files WHERE id=?",
      )
      .get(id);
    return row
      ? {
          id: String(row.id),
          requestId: String(row.request_id),
          // Files are named by ID. Resolve against the current data root so a
          // workspace move does not strand existing absolute paths in SQLite.
          path: join(this.root, String(row.id)),
          mimeType: String(row.mime_type),
          bytes: Number(row.bytes),
          sha256: String(row.sha256),
        }
      : undefined;
  }
  async put(
    body: ReadableStream<Uint8Array> | null,
    requestId: string,
    mimeType: string,
    authorize: () => boolean,
  ) {
    if (!body || !authorize())
      throw new ServiceError("Request is not active", 403);
    await mkdir(this.root, { recursive: true });
    const id = randomUUID(),
      path = join(this.root, id),
      temporary = path + ".part";
    const handle = await open(temporary, "wx"),
      digest = createHash("sha256");
    let bytes = 0;
    try {
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!authorize())
            throw new ServiceError("Request is no longer active", 403);
          digest.update(chunk.value);
          bytes += chunk.value.byteLength;
          let offset = 0;
          while (offset < chunk.value.length)
            offset += (await handle.write(chunk.value, offset)).bytesWritten;
        }
      } finally {
        reader.releaseLock();
      }
      if (!bytes) throw new ServiceError("Provider returned an empty file", 502, "ARTIFACT_INVALID");
      await handle.close();
      if (!authorize())
        throw new ServiceError("Request is no longer active", 403);
      await rename(temporary, path);
      const sha256 = digest.digest("hex");
      this.db
        .prepare("INSERT INTO files VALUES (?,?,?,?,?,?)")
        .run(id, requestId, path, mimeType, bytes, sha256);
      return { id, requestId, path, mimeType, bytes, sha256 };
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      await unlink(path).catch(() => {});
      throw error;
    }
  }
}

export async function fileResponse(path: string, mime: string, range?: string) {
  let size: number;
  try {
    const details = await stat(path);
    if (!details.isFile()) throw new Error();
    size = details.size;
  } catch {
    throw new ServiceError("File not found", 404, "file_not_found");
  }
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Content-Length": String(size),
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  let start = 0,
    end = size - 1,
    status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (start < 0 || start >= size || end < start)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
  }
  // Keep one Headers instance: the node adapter materializes streaming
  // Responses lazily, and must retain correlation headers added by middleware.
  if (size === 0) return new Response(null, { headers: new Headers(headers) });
  return new Response(
    Readable.toWeb(
      createReadStream(path, { start, end }),
    ) as ReadableStream<Uint8Array>,
    { status, headers: new Headers(headers) },
  );
}
