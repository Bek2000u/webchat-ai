import type { TextUiPage } from "../text.js";

const WELCOME = '[role="dialog"]:has-text("Пустой файл Vids"), [role="dialog"]:has-text("Blank Vids"), .modal-dialog:has-text("Пустой файл Vids"), .modal-dialog:has-text("Blank Vids")';
const CLOSE = `${WELCOME.split(", ").map(root => `${root} :is(button, [role="button"]):is([aria-label="Закрыть"], [aria-label="Close"], [title="Закрыть"], [title="Close"])`).join(", ")}`;
const VOICE = ':is(button, [role="button"], [role="tab"]):is([aria-label*="Закадровая речь"], [aria-label*="voiceover" i], [data-tooltip*="Закадровая речь"], [data-tooltip*="voiceover" i]), :is(button, [role="button"], [role="tab"]):has-text("Закадровая речь"), :is(button, [role="button"], [role="tab"]):has-text("Voiceover")';

/** Read UI only. Native credentials and RPC generation remain in transport.ts. */
export function readGoogleVidsVoicePanel() {
  const visible = (node: Element) => !node.closest('[hidden], [aria-hidden="true"], [inert]') && !!node.getClientRects().length;
  return Array.from(document.querySelectorAll('[role="tab"],[role="radio"],button,[role="button"],span,div')).some(node =>
    visible(node) && /^(?:Эта сцена|Все сцены|This scene|All scenes)$/i.test(node.textContent?.replace(/\s+/g, " ").trim() || ""));
}

/** Idempotent editor preparation; never presses Generate or touches the script. */
export async function prepareGoogleVidsUi(
  page: Pick<TextUiPage, "locator" | "evaluate" | "waitFor">,
  nativeReady?: () => Promise<boolean>,
) {
  let step = "welcome";
  try {
    if (await page.locator(WELCOME).isVisible()) {
      await page.locator(CLOSE).click();
      await page.waitFor(async () => !(await page.locator(WELCOME).isVisible()));
    }
    if (await page.evaluate(readGoogleVidsVoicePanel, undefined)) return;
    // An already captured native transport is authoritative; reopening a
    // sidebar during every account refresh can toggle a healthy panel closed.
    if (await nativeReady?.()) return;
    step = "open_voiceover";
    await page.locator(VOICE).click();
    step = "voiceover_panel";
    await page.waitFor(async () => await nativeReady?.() || await page.evaluate(readGoogleVidsVoicePanel, undefined));
  } catch (error) {
    if ((error as { code?: string }).code === "BROWSER_UI_TIMEOUT")
      throw Object.assign(Error(`Google Vids UI did not become ready: ${step}`), { code: "GOOGLE_VIDS_UI_NOT_READY" });
    throw error;
  }
}
