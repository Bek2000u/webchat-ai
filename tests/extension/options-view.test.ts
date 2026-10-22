import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { createOptionsView } from "../../src/extension/options-view.js";
import { type ExtensionSnapshot, type ProviderCommand } from "../../src/shared/contracts.js";

async function fixture(development=false) {
  const {document}=parseHTML(await readFile(new URL("../../src/extension/entrypoints/options/index.html",import.meta.url),"utf8"));
  const commands:ProviderCommand[]=[];
  const view=createOptionsView(document as unknown as Document,(key,value)=>`${key}${value?": "+value:""}`,development,value=>commands.push(value));
  const snapshot:ExtensionSnapshot={profileId:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",apiOrigin:"http://127.0.0.1:8000",connected:true,providers:[{id:"qwen_web",enabled:true,available:true,accountTier:"free"}]};
  return {document,view,snapshot,commands};
}
test("compact options renders typed status, clears old errors, preserves controls and never reveals credentials",async()=>{
  const f=await fixture();
  f.view.render(f.snapshot,new Set());
  assert.equal(f.document.querySelectorAll(".provider").length,6);
  const row=f.document.querySelector('[data-provider="qwen_web"]')!;
  assert.equal(row.querySelector(".provider-state")?.getAttribute("data-state"),"ready");
  assert.equal(row.querySelector(".tier")?.textContent,"free");
  assert.equal(row.querySelector(".toggle")?.getAttribute("aria-checked"),"true");
  row.querySelector<HTMLElement>(".toggle")!.click();
  assert.deepEqual(f.commands,[{action:"setEnabled",provider:"qwen_web",enabled:false}]);
  f.view.render({...f.snapshot,connected:false,error:"Connection failed"},new Set());
  assert.equal(row.querySelector(".provider-state")?.getAttribute("data-state"),"offline");
  assert.equal(f.document.querySelector("#connectionError")?.textContent,"Connection failed");
  f.view.render({...f.snapshot,providers:[{...f.snapshot.providers[0]!,activeRequestId:"request"}]},new Set());
  assert.equal(row.querySelector(".toggle")?.hasAttribute("disabled"),true);
  assert.equal(row.querySelector(".sync")?.hasAttribute("disabled"),true);
  assert.equal(f.document.querySelector("#connectionError")?.hasAttribute("hidden"),true);
  assert.equal(f.document.querySelector('[type="password"]'),null);
  assert.equal(f.document.querySelector("#clientEmail")?.textContent,"aaaaaaaa");
  f.view.render(f.snapshot,new Set());
  assert.equal(row.querySelector(".toggle")?.hasAttribute("disabled"),false);
});
test("dev options hides provider switches and every icon control has a localized accessible label",async()=>{
  const f=await fixture(true);
  f.view.render(f.snapshot,new Set());
  for(const button of f.document.querySelectorAll(".open,.sync,.toggle,#refreshStatus")) assert.ok(button.getAttribute("aria-label"));
  for(const button of f.document.querySelectorAll(".toggle")) assert.ok(button.hasAttribute("hidden"));
  const ru=JSON.parse(await readFile(new URL("../../src/extension/public/_locales/ru/messages.json",import.meta.url),"utf8"));
  const en=JSON.parse(await readFile(new URL("../../src/extension/public/_locales/en/messages.json",import.meta.url),"utf8"));
  assert.deepEqual(Object.keys(ru).sort(),Object.keys(en).sort());
  for(const value of Object.values(ru) as {message:string}[]) assert.ok(value.message.trim());
});
test("Vids options shows the paid requirement for credit profiles and clears it after a paid refresh",async()=>{
  const f=await fixture();
  f.view.render({...f.snapshot,providers:[{id:"google_vids",enabled:true,available:false,accountTier:"free",error:{code:"GOOGLE_VIDS_PAID_PLAN_REQUIRED",message:"Unlimited required"}}]},new Set());
  const row=f.document.querySelector('[data-provider="google_vids"]')!;
  assert.equal(row.querySelector(".tier")?.textContent,"free");
  assert.equal(row.querySelector(".provider-state")?.getAttribute("data-state"),"error");
  assert.equal(row.querySelector(".provider-message")?.textContent,"vidsPaidRequired");
  f.view.render({...f.snapshot,providers:[{id:"google_vids",enabled:true,available:true,accountTier:"paid"}]},new Set());
  assert.equal(row.querySelector(".tier")?.textContent,"paid");
  assert.equal(row.querySelector(".provider-state")?.getAttribute("data-state"),"ready");
  assert.equal(row.querySelector(".provider-message")?.hasAttribute("hidden"),true);
});

test("server popup shows an empty password field and never turns an unconfigured origin into a local app link",async()=>{
  const {document}=parseHTML(await readFile(new URL("../../src/extension/entrypoints/options/index.html",import.meta.url),"utf8"));
  const view=createOptionsView(document as unknown as Document,key=>key,false,()=>{},true);
  view.render({profileId:"fixture",apiOrigin:"",connected:false,providers:[]},new Set());
  assert.equal(document.querySelector<HTMLInputElement>("#serverToken")?.type,"password");
  assert.equal(document.querySelector<HTMLInputElement>("#serverToken")?.value,"");
  assert.equal(document.querySelector<HTMLInputElement>("#serverOrigin")?.placeholder,"https://webchat.example.com");
  assert.equal(document.querySelector("#openApp")?.hasAttribute("href"),false);
  assert.equal(document.querySelector("#openApp")?.hasAttribute("hidden"),true);
  assert.equal(document.querySelector("#companionUpdates")?.hasAttribute("hidden"),true);
  assert.equal(document.querySelector("#companionMode")?.textContent,"serverCompanion");
});
