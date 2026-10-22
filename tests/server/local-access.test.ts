import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLocalUI, fileSigningSecret } from "../../src/server/auth.js";
import { startApi } from "../../src/server/index.js";

test("local UI opens without login but rejects hostile origins, opaque frames and rebinding", async () => {
  const app = new Hono();
  app.use("*", async (c,next) => { try { requireLocalUI(c); } catch { return c.text("denied",403); } await next(); });
  app.all("*", c=>c.text("ok"));
  const url="http://127.0.0.1:8000/api/api-keys";
  assert.equal((await app.request(url)).status,200);
  assert.equal((await app.request(url,{method:"POST",headers:{origin:"http://127.0.0.1:8000","sec-fetch-site":"same-origin"}})).status,200);
  for(const origin of ["https://evil.test","null","http://127.0.0.1:9000"])
    assert.equal((await app.request(url,{headers:{origin}})).status,403);
  for(const site of ["cross-site","same-site"])
    assert.equal((await app.request(url,{headers:{"sec-fetch-site":site}})).status,403);
  assert.equal((await app.request("http://rebind.test:8000/api/accounts")).status,403);
  await assert.rejects(startApi({HOST:"0.0.0.0"}),/loopback/);
});
test("media signing survives restart without owner credentials and never replaces a corrupt key", async () => {
  const dir=await mkdtemp(join(tmpdir(),"webchat-ai-media-key-"));
  try {
    const first=await fileSigningSecret(dir);
    assert.equal(await fileSigningSecret(dir),first);
    await writeFile(join(dir,"file-signing.key"),"corrupt");
    await assert.rejects(fileSigningSecret(dir),/not replaced/);
    assert.equal(await readFile(join(dir,"file-signing.key"),"utf8"),"corrupt");
  } finally { await rm(dir,{recursive:true,force:true}); }
});
