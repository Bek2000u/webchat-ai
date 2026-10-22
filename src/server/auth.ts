import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { type Context } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DatabaseSync } from "node:sqlite";
import { ServiceError } from "./errors.js";
import { type ApiKeyRecord, type CreatedApiKey } from "../shared/contracts.js";

/** Local UI has no login. Reject hostile origins and DNS rebinding. */
export function requireLocalUI(c: Context) {
  const url = new URL(c.req.url), origin = c.req.header("origin");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      (origin && origin !== url.origin) ||
      ["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") || ""))
    throw new ServiceError("Local UI access required", 403);
}
/** Server dashboard and Playground share one configured administrator token. */
export function requireServerUI(c: Context, serverToken: string) {
  const match = /^Basic\s+([^\s]+)$/i.exec(c.req.header("authorization") ?? "");
  const credentials = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
  if (!serverToken || !equal(credentials, `admin:${serverToken}`)) {
    c.header("WWW-Authenticate", 'Basic realm="WebChat AI", charset="UTF-8"');
    throw new ServiceError("Server administrator authentication required", 401, "authentication_error");
  }
  // The reverse proxy may terminate TLS. Compare the public Host, without trusting
  // arbitrary forwarded headers, and retain browser Fetch Metadata protection.
  const origin = c.req.header("origin");
  let sameHost = true;
  if (origin) {
    try {
      const source = new URL(origin);
      sameHost = ["http:", "https:"].includes(source.protocol) && source.host === new URL(c.req.url).host;
    } catch { sameHost = false; }
  }
  if (!sameHost || ["cross-site", "same-site"].includes(c.req.header("sec-fetch-site") ?? ""))
    throw new ServiceError("Same-origin dashboard access required", 403);
}
export class Auth {
  constructor(readonly keys: KeyStore, readonly secret: string, private readonly internalApiKey = "", private readonly serverToken = "") {}
  requireApi(c: Context) {
    // Same-origin Playground does not need to store a client API key.
    if (c.req.header("sec-fetch-site") === "same-origin") {
      if (this.serverToken) requireServerUI(c, this.serverToken);
      else requireLocalUI(c);
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    const credential = match?.[1]?.trim() ?? "";
    if (!(this.internalApiKey && equal(credential, this.internalApiKey)) && !this.keys.verifyKey(credential))
      throw new ServiceError(
        "Valid API key required",
        401,
        "authentication_error",
      );
  }
  signFile(fileId: string) {
    const expires = Math.floor(Date.now() / 1000) + 86400;
    return `${expires}.${this.fileSignature(fileId, expires)}`;
  }
  verifyFile(fileId: string, token: string) {
    const [raw, signature, ...rest] = token.split(".");
    const expiry = Number(raw);
    return (
      !rest.length &&
      Number.isSafeInteger(expiry) &&
      expiry >= Math.floor(Date.now() / 1000) &&
      !!signature &&
      equal(signature, this.fileSignature(fileId, expiry))
    );
  }
  private fileSignature(fileId: string, expires: number) {
    return createHmac("sha256", this.secret)
      .update(`file:${fileId}:${expires}`)
      .digest("hex");
  }
}

/** Media URL signing only. No owner password or login session. */
export async function fileSigningSecret(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "file-signing.key");
  try {
    await writeFile(path, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const secret = (await readFile(path, "utf8")).trim();
  if (secret.length < 32) throw Error("Invalid media signing key; existing data was not replaced");
  return secret;
}

export function hash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
type KeyRow = {
  id: string;
  label: string;
  enabled: number;
  key_hash: string;
  created_at: string;
  updated_at: string;
};
export class KeyStore {
  constructor(
    readonly db: DatabaseSync,
    bootstrapKey = "",
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,label TEXT NOT NULL,key_hash TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if (bootstrapKey.trim()) {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO api_keys VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET key_hash=excluded.key_hash,enabled=1,updated_at=excluded.updated_at",
      ).run(
        "configured",
        "Environment bootstrap key",
        hash(bootstrapKey.trim()),
        1,
        now,
        now,
      );
    } else db.prepare("DELETE FROM api_keys WHERE id='configured'").run();
  }
  private keyRow(id: string) {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE id=?")
      .get(id) as KeyRow | undefined;
  }
  private publicKey(row: KeyRow): ApiKeyRecord {
    return {
      id: row.id,
      label: row.label,
      enabled: !!row.enabled,
      source: row.id === "configured" ? "environment" : "ui",
      mutable: row.id !== "configured",
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  listKeys() {
    return this.db
      .prepare(
        "SELECT * FROM api_keys ORDER BY CASE WHEN id='configured' THEN 0 ELSE 1 END,created_at DESC",
      )
      .all()
      .map((r) => this.publicKey(r as KeyRow));
  }
  verifyKey(secret: string) {
    if (!secret) return false;
    const digest = hash(secret);
    return this.db
      .prepare("SELECT * FROM api_keys WHERE enabled=1")
      .all()
      .some((r) => equal(digest, String(r.key_hash)));
  }
  createKey(label: string): CreatedApiKey {
    label = label.trim();
    if (!label || label.length > 80)
      throw new ServiceError(
        "API key label must contain 1 to 80 characters",
        422,
      );
    const id = `key_${randomBytes(8).toString("hex")}`,
      secret = `api_live_${randomBytes(32).toString("base64url")}`,
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO api_keys VALUES (?,?,?,?,?,?)")
      .run(id, label, hash(secret), 1, now, now);
    return { key: this.publicKey(this.keyRow(id)!), secret };
  }
  setKeyEnabled(id: string, enabled: boolean) {
    this.mutable(id);
    if (!this.keyRow(id)) throw new ServiceError("API key not found", 404);
    this.db
      .prepare("UPDATE api_keys SET enabled=?,updated_at=? WHERE id=?")
      .run(+enabled, new Date().toISOString(), id);
    return this.publicKey(this.keyRow(id)!);
  }
  deleteKey(id: string) {
    this.mutable(id);
    if (!this.keyRow(id)) throw new ServiceError("API key not found", 404);
    this.db.prepare("DELETE FROM api_keys WHERE id=?").run(id);
  }
  private mutable(id: string) {
    if (id === "configured")
      throw new ServiceError(
        "Environment bootstrap key is managed through configuration",
        409,
      );
  }
}
