import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { detectChatGptAccount } from "../../src/extension/providers/chatgpt.js";
import { detectGeminiPageContext } from "../../src/extension/providers/gemini.js";
import { providerStatusSchema } from "../../src/shared/contracts.js";

test("ChatGPT tier comes from authenticated account plan, never its selected model", async () => {
  for (const [plan, expected] of [["free","free"],["pro","paid"],["plus","paid"],["unrecognized","unknown"],[undefined,"unknown"]]) {
    const result = await runInNewContext(`(${detectChatGptAccount.toString()})()`, {
      __name: (x:unknown)=>x, location:{origin:"https://chatgpt.com"}, AbortSignal,
      fetch:async()=>Response.json({user:{email:"owner@example.test"},account:{planType:plan},accessToken:"private-token"}),
    });
    assert.equal(result.accountTier,expected); assert.equal(JSON.stringify(result).includes("private-token"),false);
    assert.equal(result.accountSubject,"owner@example.test");
  }
});
test("Gemini paid badge overrides upgrade offer; missing evidence remains unknown", async () => {
  for(const [label,upsell,expected] of [["Pro",true,"paid"],["Ultra",false,"paid"],["",true,"free"],["",false,"unknown"],["unrecognized",true,"unknown"]] as const) {
    const result=await runInNewContext(`(${detectGeminiPageContext.toString()})(1000)`,{
      __name:(x:unknown)=>x, AbortController,setTimeout,clearTimeout,location:{href:"https://gemini.google.com/app"},
      fetch:async()=>new Response('"SNlM0e":"private-csrf"'),
      document:{body:{innerText:""},querySelectorAll:()=>[{getAttribute:()=>"owner@example.test"}],
        querySelector:(selector:string)=>selector===".mavatar-tier-label"?{textContent:label}:upsell?{getClientRects:()=>[{}]}:null},
    });
    assert.equal(result.accountTier,expected); assert.equal(JSON.stringify(result).includes("private-csrf"),false);
  }
});
test("provider hello retains the tier without extra raw account data",()=>{
  assert.equal(providerStatusSchema.parse({id:"chatgpt_web",available:true,accountTier:"paid"}).accountTier,"paid");
  assert.throws(()=>providerStatusSchema.parse({id:"chatgpt_web",available:true,accountTier:"guess"}));
});
