import { type ProviderId, type ExtensionSnapshot, type ProviderCommand } from "../shared/contracts.js";
import { DEV_COMPANION, SERVER_COMPANION } from "./mode.js";
import { sendMessage } from "./runtime/runtime.js";
import { normalizeServerOrigin, serverPermissionOrigin } from "./runtime/origin.js";
import { createOptionsView } from "./options-view.js";
import { popupLanguage, popupTranslator, POPUP_LANGUAGE_KEY } from "./i18n.js";
import "./options.css";

document.addEventListener("DOMContentLoaded", async () => {
  const stored = await chrome.storage.local.get(POPUP_LANGUAGE_KEY);
  const language = popupLanguage(stored[POPUP_LANGUAGE_KEY] || chrome.i18n.getUILanguage());
  const t = popupTranslator(language);
  document.documentElement.lang=language;
  const busy=new Set<ProviderId>();
  let snapshot: ExtensionSnapshot | undefined, refreshing=false, dirty=false, saving=false;
  const view=createOptionsView(document,t,DEV_COMPANION,value=>void action(value),SERVER_COMPANION);
  const origin=view.element<HTMLInputElement>("#serverOrigin"), save=view.element<HTMLButtonElement>("#saveConnection");
  const token=document.querySelector<HTMLInputElement>("#serverToken");
  const locale=view.element<HTMLSelectElement>("#language"); locale.value=language;
  locale.setAttribute("aria-label",t("language"));
  locale.addEventListener("change",()=>{ void chrome.storage.local.set({[POPUP_LANGUAGE_KEY]:popupLanguage(locale.value)}).then(()=>location.reload()); });
  view.element("#extensionVersion").textContent="v"+chrome.runtime.getManifest().version;
  const render = () => { if(snapshot) view.render(snapshot,busy); };
  function report(error: unknown) {
    const message=error instanceof Error?error.message:String(error);
    view.message("#clientMessage",message.includes("PROVIDER_BUSY")?t("busyError"):
      message.includes("SERVER_TOKEN_REQUIRED")?t("tokenRequired"):
      message.includes("SERVER_CONNECTION_REQUIRED")?t("serverHint"):message,true);
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
      const result=await sendMessage("configure",{apiOrigin,...(token?.value.trim()?{serverToken:token.value.trim()}:{})});
      if(!result.success)throw Error(result.error);
      if(token)token.value="";
      dirty=false;origin.value=apiOrigin;view.message("#clientMessage",t("saved"));
      await refresh();
    }).catch(report).finally(()=>{saving=false;save.disabled=false;save.textContent=t("save");});
  });
  async function updateCompanion(reload=false) {
    const check=view.element<HTMLButtonElement>("#checkUpdate"), reloadButton=view.element<HTMLButtonElement>("#reloadCompanion");
    check.disabled=true; reloadButton.disabled=true;
    try {
      const update=await sendMessage("companionUpdate",{action:reload?"reload":"check"});
      view.message("#updateMessage",t(update.available ? update.busy ? "updateBusy" : "updateAvailable" : "companionCurrent",update.version));
      reloadButton.hidden=!update.available;
      reloadButton.disabled=update.busy;
    } catch { view.message("#updateMessage",t("updateCheckFailed"),true); reloadButton.hidden=true; }
    finally {check.disabled=false;}
  }
  view.element("#checkUpdate").addEventListener("click",()=>void updateCompanion());
  view.element("#reloadCompanion").addEventListener("click",()=>void updateCompanion(true));
  void refresh();
  if(!SERVER_COMPANION&&!DEV_COMPANION)void updateCompanion();
  const timer=setInterval(()=>void refresh(),2500);
  window.addEventListener("pagehide",()=>clearInterval(timer),{once:true});
});
