import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";

/** Render the real popup view in an owned Electron test window; no Chrome/provider calls. */

export async function smokeExtensionUI(desktop: ElectronApplication, output: string) {
  const html=(await readFile("src/extension/entrypoints/options/index.html","utf8")).replace(/<script[\s\S]*?<\/script>/g,"");
  const css=await readFile("src/extension/options.css","utf8");
  const bundle=await build({stdin:{contents:`
    import {createOptionsView} from "./src/extension/options-view.ts";
    import {popupTranslator} from "./src/extension/i18n.ts";
    import {PROVIDERS} from "./src/shared/contracts.ts";
    globalThis.fixtureCommands=[];
    globalThis.renderFixture=(lang,server)=>{
      const t=popupTranslator(lang);
      const view=createOptionsView(document,t,false,value=>globalThis.fixtureCommands.push(value),server);
      const origin=server?"https://webchat.example.com":"http://127.0.0.1:8000";
      view.render({profileId:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",apiOrigin:origin,connected:true,providers:Object.values(PROVIDERS).map((p,i)=>({id:p.id,enabled:i!==2,available:i!==3,accountTier:i===0?"paid":"unknown",...(i===1?{activeRequestId:"fixture-request"}:{}),...(i===3?{error:{code:"LOGIN_REQUIRED",message:lang==="ru"?"Войдите в аккаунт":lang==="uz"?"Hisobga kiring":"Sign in",provider:p.id,stage:"account"}}:{})}))},new Set());
      document.documentElement.lang=lang;
      document.querySelector("#language").value=lang;
      document.querySelector("#extensionVersion").textContent="v1.0.1";
      document.querySelector("#serverOrigin").value=origin;
      if(!server){view.message("#updateMessage",t("updateBusy","1.0.2"));document.querySelector("#reloadCompanion").hidden=false;document.querySelector("#reloadCompanion").disabled=true;}
    };
  `,resolveDir:resolve("."),sourcefile:"extension-ui-fixture.ts",loader:"ts"},write:false,bundle:true,platform:"browser",format:"iife",target:"chrome116"});
  const created=desktop.waitForEvent("window");
  await desktop.evaluate(({BrowserWindow})=>{const popup=new BrowserWindow({width:392,height:600,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true}});void popup.loadURL("about:blank");});
  const page=await created;
  const window=await desktop.browserWindow(page);
  try {
    for(const [language,theme,width,server] of [["ru","dark",392,false],["en","light",392,false],["uz","light",375,false],["ru","dark",392,true],["en","light",392,true],["uz","light",375,true]] as const){
      await window.evaluate((popup,width)=>popup.setContentSize(width,600),width);
      await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
      await page.setContent(html);
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:bundle.outputFiles[0]!.text});
      await page.evaluate(({language,server})=>(globalThis as unknown as {renderFixture:(value:string,server:boolean)=>void}).renderFixture(language,server),{language,server});
      assert.equal(await page.locator(".provider").count(),6);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
      assert.equal(await page.evaluate(()=>innerHeight<=600),true);
      assert.equal(await page.evaluate(()=>[document.documentElement,document.body].some(node=>["hidden","clip"].includes(getComputedStyle(node).overflowY))),false);
      assert.equal(await page.locator("#serverToken").count(),server?1:0);
      assert.equal(await page.locator("#companionUpdates").isVisible(),!server);
      // Native Chrome caps action popups at 600px. Longer localized content may
      // scroll vertically; every control must remain reachable without clipping.
      const controls=page.locator("button:visible:not(:disabled),input:visible,select:visible,a:visible");
      for(let i=0;i<await controls.count();i++){
        const control=controls.nth(i);
        await control.scrollIntoViewIfNeeded();
        await control.focus();
        assert.equal(await control.evaluate(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight;}),true);
      }
      for(const provider of await page.locator(".provider").all()){
        await provider.scrollIntoViewIfNeeded();
        assert.equal(await provider.isVisible(),true);
      }
      await page.locator('[data-provider="chatgpt_web"] .open').click();
      assert.deepEqual(await page.evaluate(()=>(globalThis as unknown as {fixtureCommands:unknown[]}).fixtureCommands),[{action:"open",provider:"chatgpt_web"}]);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement!).outlineStyle),"solid");
      await page.evaluate(()=>globalThis.scrollTo(0,0));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const png=await window.evaluate(async popup=>(await popup.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString("base64"));
      await writeFile(join(output,`extension-${server?"server":"desktop"}-${language}-${theme}-${width}.png`),Buffer.from(png,"base64"));
      if(server){
        await page.locator("#openApp").scrollIntoViewIfNeeded();
        assert.equal(await page.locator("#openApp").evaluate(node=>node.getBoundingClientRect().bottom<=innerHeight),true);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const bottom=await window.evaluate(async popup=>(await popup.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString("base64"));
        await writeFile(join(output,`extension-server-${language}-scrolled.png`),Buffer.from(bottom,"base64"));
      }
    }
  } finally {await window.evaluate(popup=>popup.destroy());}
}
