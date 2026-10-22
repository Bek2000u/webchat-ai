import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type BrowserIdentity,
  type ProviderId,
  type ProviderStatus,
  type RequestError,
  type RequestRecord,
  type RequestAttempt,
  type SDKRequest,
  type SDKResult,
} from "../shared/contracts.js";

export interface BrowserProfile {
  id: string;
  label: string;
  browserIdentity?: BrowserIdentity;
  enabled: boolean;
  disabledProviders: ProviderId[];
  tokenHash: string;
  providers: ProviderStatus[];
  extensionVersion: string;
  createdAt: string;
  updatedAt: string;
}
type Row = Record<string, unknown>;
export const hashToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function matchesToken(token: string, hash: string) {
  const actual = Buffer.from(hashToken(token)),
    expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A request/result journal. Incomplete requests are never executed after restart. */
export class ApiStore {
  private constructor(readonly db: DatabaseSync) {}
  static async open({ path }: { path: string }) {
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: false });
    try {
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      db.close();
      throw error;
    }
    const store = new ApiStore(db);
    store.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, request_json TEXT NOT NULL, status TEXT NOT NULL,
      profile_id TEXT, result_json TEXT, error_json TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attempts_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, enabled INTEGER NOT NULL,
      token_hash TEXT NOT NULL, providers_json TEXT NOT NULL, disabled_providers_json TEXT NOT NULL,
      extension_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      browser_identity_json TEXT);`);
    store.db
      .prepare(
        "UPDATE requests SET status='error',error_json=?,updated_at=? WHERE status IN ('pending','running')",
      )
      .run(
        JSON.stringify({
          code: "outcome_unknown",
          message:
            "Host stopped before this request finished; it will not be executed again",
        }),
        new Date().toISOString(),
      );
    return store;
  }
  private request(row: Row): RequestRecord {
    return {
      id: String(row.id),
      request: JSON.parse(String(row.request_json)),
      status: row.status as RequestRecord["status"],
      ...(row.profile_id ? { profileId: String(row.profile_id) } : {}),
      ...(row.result_json !== null
        ? { result: JSON.parse(String(row.result_json)) }
        : {}),
      ...(row.error_json !== null
        ? { error: JSON.parse(String(row.error_json)) }
        : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      attempts: JSON.parse(String(row.attempts_json ?? "[]")),
    };
  }
  createRequest(request: SDKRequest): RequestRecord {
    const id = randomUUID(),
      stamp = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO requests (id,request_json,status,created_at,updated_at) VALUES (?,?,'pending',?,?)",
      )
      .run(id, JSON.stringify(request), stamp, stamp);
    return this.getRequest(id)!;
  }
  getRequest(id: string): RequestRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE id=?")
      .get(id);
    return row ? this.request(row) : undefined;
  }
  listRequests(limit = 100): RequestRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM requests ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => this.request(row));
  }
  pendingRequests(): RequestRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM requests WHERE status='pending' ORDER BY rowid",
      )
      .all()
      .map((row) => this.request(row));
  }
  startRequest(id: string, profileId: string) {
    return (
      this.db
        .prepare(
          "UPDATE requests SET status='running',profile_id=?,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(profileId, new Date().toISOString(), id).changes > 0
    );
  }
  completeRequest(id: string, result: SDKResult) {
    this.db
      .prepare(
        "UPDATE requests SET status='completed',result_json=?,updated_at=? WHERE id=? AND status='running'",
      )
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }
  updateAttempts(id: string, attempts: RequestAttempt[]) {
    this.db.prepare("UPDATE requests SET attempts_json=? WHERE id=?")
      .run(JSON.stringify(attempts), id);
  }
  retryRequest(id: string) {
    return this.db.prepare("UPDATE requests SET status='pending',profile_id=NULL,updated_at=? WHERE id=? AND status='running'")
      .run(new Date().toISOString(), id).changes > 0;
  }
  failRequest(id: string, error: RequestError) {
    this.db
      .prepare(
        "UPDATE requests SET status='error',error_json=?,updated_at=? WHERE id=? AND status IN ('pending','running')",
      )
      .run(JSON.stringify(error), new Date().toISOString(), id);
  }
  createProfile(id: string, token: string, label = id) {
    const tokenHash = hashToken(token);
    const old = this.getProfile(id),
      stamp = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO profiles (id,label,enabled,token_hash,providers_json,disabled_providers_json,extension_version,created_at,updated_at) VALUES (?,?,1,?,'[]','[]','',?,?) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,label=excluded.label,enabled=1,updated_at=excluded.updated_at`,
      )
      .run(id, label, tokenHash, old?.createdAt ?? stamp, stamp);
    return this.getProfile(id)!;
  }
  getProfile(id: string): BrowserProfile | undefined {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE id=?")
      .get(id);
    return row
      ? {
          id: String(row.id),
          label: String(row.label),
          ...(row.browser_identity_json ? { browserIdentity: JSON.parse(String(row.browser_identity_json)) } : {}),
          enabled: !!row.enabled,
          disabledProviders: JSON.parse(String(row.disabled_providers_json)),
          tokenHash: String(row.token_hash),
          providers: JSON.parse(String(row.providers_json)),
          extensionVersion: String(row.extension_version),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        }
      : undefined;
  }
  listProfiles(): BrowserProfile[] {
    return this.db
      .prepare(
        "SELECT id FROM profiles ORDER BY created_at,id",
      )
      .all()
      .map((row) => this.getProfile(String(row.id))!);
  }
  authenticateProfile(id: string, token: string) {
    const profile = this.getProfile(id);
    return profile?.enabled && matchesToken(token, profile.tokenHash)
      ? profile
      : undefined;
  }
  registerProfile(
    id: string,
    extensionVersion: string,
    providers: ProviderStatus[],
    browserIdentity?: BrowserIdentity,
  ) {
    this.db
      .prepare(
        "UPDATE profiles SET providers_json=?,extension_version=?,updated_at=?,browser_identity_json=? WHERE id=?",
      )
      .run(
        JSON.stringify(providers),
        extensionVersion,
        new Date().toISOString(),
        browserIdentity ? JSON.stringify(browserIdentity) : null,
        id,
      );
  }
  updateProfile(
    id: string,
    value: {
      label?: string;
      enabled?: boolean;
      disabledProviders?: ProviderId[];
    },
  ) {
    const profile = this.getProfile(id);
    if (!profile) return;
    this.db
      .prepare(
        "UPDATE profiles SET label=?,enabled=?,disabled_providers_json=?,updated_at=? WHERE id=?",
      )
      .run(
        value.label ?? profile.label,
        Number(value.enabled ?? profile.enabled),
        JSON.stringify(value.disabledProviders ?? profile.disabledProviders),
        new Date().toISOString(),
        id,
      );
    return this.getProfile(id);
  }
  deleteProfile(id: string) {
    this.db.prepare("DELETE FROM profiles WHERE id=?").run(id);
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
