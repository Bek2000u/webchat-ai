import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { type ElectronApplication } from "playwright";

/** Render the real popup view in an owned Electron test window; no Chrome/provider calls. */

export async function smokeExtensionUI(desktop: ElectronApplication, output: string) {
  const html=(await readFile("src/extension/entrypoints/options/index.html","utf8")).replace(/<script[\s\S]*?<\/script>/g,"");
  const css=await readFile("src/extension/options.css","utf8");
  const locales:Record<string,unknown>={};
  for(const lang of ["ru","en"]) locales[lang]=JSON.parse(await readFile(`src/extension/public/_locales/${lang}/messages.json`,"utf8"));
  const bundle=await build({stdin:{contents:`
    import {createOptionsView} from "./src/extension/options-view.ts";
    import {PROVIDERS} from "./src/shared/contracts.ts";
    const locales=${JSON.stringify(locales)};
    globalThis.fixtureCommands=[];
    globalThis.renderFixture=(lang)=>{
      const t=(key,substitution)=>locales[lang][key]?.message.replace(/\\$provider\\$/g,substitution||"")||key;
      const view=createOptionsView(document,t,false,value=>globalThis.fixtureCommands.push(value));
      view.render({profileId:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",apiOrigin:"http://127.0.0.1:8000",connected:true,providers:Object.values(PROVIDERS).map((p,i)=>({id:p.id,enabled:i!==2,available:i!==3,accountTier:i===0?"paid":"unknown",...(i===1?{activeRequestId:"fixture-request"}:{}),...(i===3?{error:{code:"LOGIN_REQUIRED",message:lang==="ru"?"Войдите в аккаунт":"Sign in",provider:p.id,stage:"account"}}:{})}))},new Set());
      document.querySelector("#extensionVersion").textContent="v1.0.19";
      document.querySelector("#serverOrigin").value="http://127.0.0.1:8000";
    };
  `,resolveDir:resolve("."),sourcefile:"extension-ui-fixture.ts",loader:"ts"},write:false,bundle:true,platform:"browser",format:"iife",target:"chrome116"});
  const created=desktop.waitForEvent("window");
  await desktop.evaluate(({BrowserWindow})=>{const popup=new BrowserWindow({width:392,height:560,show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,offscreen:true}});void popup.loadURL("about:blank");});
  const page=await created;
  const window=await desktop.browserWindow(page);
  try {
    for(const [language,theme,width] of [["ru","dark",392],["en","light",392],["ru","light",375]] as const){
      await window.evaluate((popup,width)=>popup.setContentSize(width,560),width);
      await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
      await page.setContent(html);
      await page.addStyleTag({content:css});
      await page.addScriptTag({content:bundle.outputFiles[0]!.text});
      await page.evaluate(language=>(globalThis as unknown as {renderFixture:(value:string)=>void}).renderFixture(language),language);
      assert.equal(await page.locator(".provider").count(),6);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>document.documentElement.clientHeight),false);
      const label=language==="ru"?"Открыть ChatGPT Web":"Open ChatGPT Web";
      await page.getByRole("button",{name:label,exact:true}).click();
      assert.deepEqual(await page.evaluate(()=>(globalThis as unknown as {fixtureCommands:unknown[]}).fixtureCommands),[{action:"open",provider:"chatgpt_web"}]);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement!).outlineStyle),"solid");
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const png=await window.evaluate(async popup=>(await popup.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString("base64"));
      await writeFile(join(output,`extension-${language}-${theme}-${width}.png`),Buffer.from(png,"base64"));
    }
  } finally {await window.evaluate(popup=>popup.destroy());}
}
