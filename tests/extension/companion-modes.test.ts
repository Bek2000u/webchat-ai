import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BrowserRuntime, HOST_SETTINGS_KEY, type BrowserSocket } from "../../src/extension/runtime/runtime.js";
import { connectionConfigSchema } from "../../src/shared/contracts.js";
import { checkCompanionUpdate, newerCompanionVersion, reloadCompanionWhenIdle } from "../../src/extension/updates.js";
import { popupLanguage, popupTranslator } from "../../src/extension/i18n.js";

test("server companion keeps a distinct stable ID and no implicit loopback build origin", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../src/extension/manifest.json", import.meta.url), "utf8"));
  const server = JSON.parse(await readFile(new URL("../../src/extension/server-key.json", import.meta.url), "utf8"));
  const id = (key: string) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0,32)]
    .map(digit=>String.fromCharCode(97+parseInt(digit,16))).join("");
  assert.equal(id(server.key), "opcdjnhnokdpibdhglkjfohgnjokakfp");
  assert.equal(server.id, id(server.key));
  assert.notEqual(id(server.key), id(manifest.key));
  assert.notEqual(id(server.key), "epmfnjjinilkfldoafibcgkpenbhlidm");
  const config = await readFile(new URL("../../src/extension/wxt.config.ts", import.meta.url), "utf8");
  assert.match(config, /server \? "" : "http:\/\/127\.0\.0\.1:8001"/);
  assert.match(config, /dist\/extension-server/);
  assert.equal("update_url" in manifest, false);
});

test("server runtime waits for explicit origin/token and sends the secret only in socket auth", async () => {
  const data:Record<string,unknown>={};
  const storage={async get(key:string){return {[key]:data[key]};},async set(value:Record<string,unknown>){Object.assign(data,value);}};
  const sockets:{url:string;auth:Record<string,unknown>}[]=[];
  const listeners = new Map<string, () => void>();
  const emitted: unknown[]=[];
  let refreshes=0;
  const runtime=new BrowserRuntime([],storage,{extensionVersion:"1.0.1",serverCompanion:true,
    socketFactory:(url,auth)=>{sockets.push({url,auth});return {
      on(event:string,callback:()=>void){listeners.set(event,callback);return this;},
      emit(_event:string,value:unknown){emitted.push(value);},connect(){},disconnect(){},
    } as unknown as BrowserSocket;}});
  runtime.refreshProviders=async()=>{refreshes++;};
  await runtime.initialize();
  assert.equal(runtime.settings.serverOrigin, "");
  assert.deepEqual(await runtime.connect(),{success:false,error:"SERVER_CONNECTION_REQUIRED"});
  assert.equal(refreshes,0);
  assert.equal(sockets.length,0);
  await assert.rejects(runtime.configure("https://webchat.example.test"),/SERVER_TOKEN_REQUIRED/);
  await runtime.configure("https://webchat.example.test", "server-secret");
  assert.equal(sockets.length,1);
  assert.equal(sockets[0].url,"https://webchat.example.test");
  assert.equal(sockets[0].auth.serverToken,"server-secret");
  assert.equal(sockets[0].auth.token,runtime.settings.token);
  listeners.get("connect")!();
  assert.equal(emitted.length,1);
  assert.equal(JSON.stringify(emitted).includes("server-secret"),false);
  assert.equal((data[HOST_SETTINGS_KEY] as {serverToken:string}).serverToken,"server-secret");
  await assert.rejects(runtime.configure("https://different.example.test"),/SERVER_TOKEN_REQUIRED/);
  assert.equal(runtime.settings.serverOrigin,"https://webchat.example.test");
  await runtime.configure("https://webchat.example.test");
  assert.equal(sockets.at(-1)?.auth.serverToken,"server-secret");
  assert.equal(connectionConfigSchema.parse({apiOrigin:"https://webchat.example.test",serverToken:"server-secret"}).serverToken,"server-secret");
});

test("desktop companion update checks only its local app and reload never interrupts a request", async () => {
  let checks=0,reloads=0;
  const request=async()=>{checks++;return new Response(JSON.stringify({extensionVersion:"1.0.2"}));};
  assert.deepEqual(await checkCompanionUpdate("https://remote.example.test","1.0.1",false,request),{available:false,busy:false});
  assert.equal(checks,0);
  assert.deepEqual(await checkCompanionUpdate("http://127.0.0.1:8001","1.0.1",true,request),{available:true,version:"1.0.2",busy:true});
  assert.throws(()=>reloadCompanionWhenIdle(1,()=>reloads++),/PROVIDER_BUSY/);
  assert.equal(reloads,0);
  reloadCompanionWhenIdle(0,()=>reloads++);
  assert.equal(reloads,1);
  assert.equal(newerCompanionVersion("1.0.1","1.0.1"),false);
  assert.equal(newerCompanionVersion("1.0.0","1.0.1"),false);
  assert.equal(newerCompanionVersion("bad","1.0.1"),false);
});

test("English, Russian and Uzbek popup catalogs are complete and replace native placeholders", async () => {
  const catalogs=await Promise.all(["en","ru","uz"].map(async language=>JSON.parse(await readFile(new URL(`../../src/extension/public/_locales/${language}/messages.json`,import.meta.url),"utf8"))));
  for(const catalog of catalogs){
    assert.deepEqual(Object.keys(catalog).sort(),Object.keys(catalogs[0]).sort());
    for(const message of Object.values(catalog) as {message:string}[])assert(message.message.trim());
  }
  assert.equal(popupLanguage("uz-UZ"),"uz");
  assert.equal(popupLanguage("ru-RU"),"ru");
  assert.equal(popupLanguage("de"),"en");
  assert.equal(popupTranslator("uz")("openProvider","Gemini"),"Geminini ochish");
  assert.match(popupTranslator("ru")("updateAvailable","1.0.2"),/1\.0\.2/);
});
