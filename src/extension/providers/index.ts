import { PROVIDERS } from "../../shared/contracts.js";
import { type ProviderAdapter, type ProviderLogger } from "../runtime/runtime.js";
import { createGeminiAdapter } from "./gemini.js";
import { createDeepSeekAdapter } from "./deepseek.js";
import { createQwenAdapter } from "./qwen.js";
import { createFlowAdapter } from "./flow/index.js";
import { createGoogleVidsAdapter } from "./google-vids/index.js";
import { createChatGptAdapter } from "./chatgpt.js";

const factories = {
  chatgpt_web: createChatGptAdapter,
  gemini_web: createGeminiAdapter,
  qwen_web: createQwenAdapter,
  deepseek_web: createDeepSeekAdapter,
  flow: createFlowAdapter,
  google_vids: createGoogleVidsAdapter,
};
export function createAdapters(
  loggers: ReadonlyMap<string, ProviderLogger> = new Map(),
): ProviderAdapter[] {
  return Object.keys(PROVIDERS).map((id) =>
    factories[id as keyof typeof factories]({ log: loggers.get(id) }),
  );
}
