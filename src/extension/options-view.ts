import {
  PROVIDERS,
  formatRequestError,
  type ProviderId,
  type ExtensionSnapshot,
  type ProviderCommand,
} from "../shared/contracts.js";

export type Translate = (key: string, substitution?: string) => string;
export function createOptionsView(document: Document, t: Translate, development: boolean, command: (value: ProviderCommand) => void, server = false) {
  const element = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const extensionName = server ? "WebChat Server Extension" : development ? "WebChat Extension Dev" : "WebChat Extension";
  document.title = extensionName;
  element("header h1").textContent = extensionName;
  const cards = new Map<ProviderId, HTMLElement>();
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) node.textContent = t(node.dataset.i18n!);
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    const label = t(node.dataset.i18nLabel!); node.title = label; node.setAttribute("aria-label", label);
  }
  element("#companionMode").textContent = t(server ? "serverCompanion" : development ? "devCompanion" : "desktopCompanion");
  element("#connectionHeading").textContent = t(server ? "serverConnection" : "connection");
  const origin = element<HTMLInputElement>("#serverOrigin");
  origin.placeholder = server ? "https://webchat.example.com" : "http://127.0.0.1:8001";
  element("#companionUpdates").hidden = server || development;
  if (server) {
    const label = document.createElement("label"); label.htmlFor = "serverToken"; label.textContent = t("serverToken");
    const input = document.createElement("input"); input.id = "serverToken"; input.type = "password";
    input.autocomplete = "off"; input.spellcheck = false; input.placeholder = t("tokenPlaceholder");
    const hint = document.createElement("p"); hint.className = "message muted"; hint.textContent = t("serverHint");
    element("#connectionForm").append(label, input, hint);
  }
  const label = (node: HTMLElement, value: string) => { node.title = value; node.setAttribute("aria-label",value); };
  for (const provider of Object.values(PROVIDERS)) {
    const fragment = element<HTMLTemplateElement>("#providerTemplate").content.cloneNode(true) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>(".provider")!;
    card.dataset.provider = provider.id;
    card.querySelector(".name")!.textContent = provider.label;
    const open = card.querySelector<HTMLButtonElement>(".open")!, sync = card.querySelector<HTMLButtonElement>(".sync")!, toggle = card.querySelector<HTMLButtonElement>(".toggle")!;
    label(open,t("openProvider",provider.label)); label(sync,t("refreshProvider",provider.label)); label(toggle,t("enableProvider",provider.label));
    open.addEventListener("click",()=>command({action:"open",provider:provider.id}));
    sync.addEventListener("click",()=>command({action:"refresh",provider:provider.id}));
    toggle.addEventListener("click",()=>command({action:"setEnabled",provider:provider.id,enabled:toggle.getAttribute("aria-checked")!=="true"}));
    toggle.hidden = development;
    cards.set(provider.id,card); element("#providers").append(fragment);
  }
  function message(selector: string, text: string, error = false) {
    const node=element(selector); node.textContent=text; node.hidden=!text; node.classList.toggle("error",error);
  }
  return {
    element, message,
    render(snapshot: ExtensionSnapshot, busy: ReadonlySet<ProviderId>) {
      const connection = element("#clientStatus"); connection.textContent=t(snapshot.connected?"connected":"offline"); connection.dataset.connected=String(snapshot.connected);
      const profile=element("#clientEmail"); profile.textContent=snapshot.profileId.slice(0,8); profile.title=snapshot.profileId;
      const app = element<HTMLAnchorElement>("#openApp");
      app.hidden = !snapshot.apiOrigin;
      if (snapshot.apiOrigin) app.href=snapshot.apiOrigin+"/dashboard";
      else app.removeAttribute("href");
      message("#connectionError", snapshot.error === "SERVER_CONNECTION_REQUIRED" ? t("serverHint") : snapshot.error || "", true);
      for (const status of snapshot.providers) {
        const card=cards.get(status.id); if(!card) continue;
        const active=Boolean(status.activeRequestId), waiting=busy.has(status.id);
        card.setAttribute("aria-busy",String(waiting));
        const state=!status.enabled?"disabled":active?"busy":!snapshot.connected?"offline":status.error?"error":status.available?"ready":"unavailable";
        const indicator=card.querySelector<HTMLElement>(".provider-state")!; indicator.dataset.state=state; label(indicator,t(state));
        const vidsPlan = status.id === "google_vids" && status.enabled
          ? status.error?.code === "GOOGLE_VIDS_PAID_PLAN_REQUIRED" ? "vidsPaidRequired"
          : /GOOGLE_VIDS_PLAN_(PENDING|UNKNOWN)/.test(status.error?.code || "") ? "vidsPlanPending" : "" : "";
        if (vidsPlan) label(indicator,t(vidsPlan));
        const tier=card.querySelector<HTMLElement>(".tier")!; tier.textContent=status.accountTier && status.accountTier!=="unknown" ? t(status.accountTier) : "";
        const toggle=card.querySelector<HTMLButtonElement>(".toggle")!, sync=card.querySelector<HTMLButtonElement>(".sync")!;
        toggle.setAttribute("aria-checked",String(status.enabled)); toggle.disabled=active||waiting; sync.disabled=active||waiting;
        label(toggle,t(status.enabled?"disableProvider":"enableProvider",PROVIDERS[status.id].label));
        const error=card.querySelector<HTMLElement>(".provider-message")!;
        error.textContent=vidsPlan ? t(vidsPlan) : status.enabled && status.error ? formatRequestError(status.error) : ""; error.hidden=!error.textContent;
      }
    },
  };
}
