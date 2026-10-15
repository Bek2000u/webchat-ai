import { type ProviderId, type ExtensionSnapshot, type ProviderCommand } from "../shared/contracts.js";
import { DEV_COMPANION } from "./mode.js";
import { sendMessage } from "./runtime/runtime.js";
import { normalizeServerOrigin, serverPermissionOrigin } from "./runtime/origin.js";
import { createOptionsView } from "./options-view.js";
import "./options.css";

document.addEventListener("DOMContentLoaded", () => {
  const t = (key: string, substitution?: string) => chrome.i18n.getMessage(key, substitution);
  document.documentElement.lang=chrome.i18n.getUILanguage().startsWith("en")?"en":"ru";
  const busy=new Set<ProviderId>();
  let snapshot: ExtensionSnapshot | undefined, refreshing=false, dirty=false, saving=false;
  const view=createOptionsView(document,t,DEV_COMPANION,value=>void action(value));
  const origin=view.element<HTMLInputElement>("#serverOrigin"), save=view.element<HTMLButtonElement>("#saveConnection");
  view.element("#extensionVersion").textContent="v"+chrome.runtime.getManifest().version;
  const render = () => { if(snapshot) view.render(snapshot,busy); };
  function report(error: unknown) {
    const message=error instanceof Error?error.message:String(error);
    view.message("#clientMessage",message.includes("PROVIDER_BUSY")?t("busyError"):message,true);
  }
  async function refresh(manual=false) {
    if(refreshing)return;
    refreshing=true;
    const button=view.element<HTMLButtonElement>("#refreshStatus");
    if(manual)button.disabled=true;
    try {
      snapshot=await sendMessage("getStatus",undefined);
      if(!dirty&&!saving)origin.value=snapshot.apiOrigin;
      render();
    } catch(error){report(error);}
    finally {refreshing=false;button.disabled=false;}
  }
  async function action(command: ProviderCommand) {
    if(busy.has(command.provider))return;
    busy.add(command.provider);render();view.message("#clientMessage","");
    try { await sendMessage("provider",command); await refresh(); }
    catch(error){report(error);}
    finally {busy.delete(command.provider);render();}
  }
  origin.addEventListener("input",()=>{dirty=true;});
  view.element("#refreshStatus").addEventListener("click",()=>void refresh(true));
  view.element<HTMLFormElement>("#connectionForm").addEventListener("submit", event => {
    event.preventDefault(); if(saving)return;
    let apiOrigin:string;
    try {apiOrigin=normalizeServerOrigin(origin.value);} catch(error){report(error);return;}
    // Chrome requires permissions.request directly inside the user gesture.
    const permission=chrome.permissions.request({origins:[serverPermissionOrigin(apiOrigin)]});
    saving=true;save.disabled=true;save.textContent=t("saving");view.message("#clientMessage","");
    void permission.then(async granted=>{
      if(!granted)throw Error(t("permissionDenied"));
      const result=await sendMessage("configure",{apiOrigin});
      if(!result.success)throw Error(result.error);
      dirty=false;origin.value=apiOrigin;view.message("#clientMessage",t("saved"));
      await refresh();
    }).catch(report).finally(()=>{saving=false;save.disabled=false;save.textContent=t("save");});
  });
  void refresh();
  const timer=setInterval(()=>void refresh(),2500);
  window.addEventListener("pagehide",()=>clearInterval(timer),{once:true});
});
