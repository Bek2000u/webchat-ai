import {
  type MediaPrompt,
  type ImageGenerationResult,
  type VideoUrlResult,
  type GeneratedImage,
  type ImageGenerationOptions,
  type VideoGenerationOptions,
} from "@tanstack/ai";
import { type ProviderContext, type ProviderMediaBody, type SiteModelOptions } from "../../runtime/runtime.js";
import {
  type FlowRpcDescriptor,
  type FlowPageResponse,
  type FlowMedia,
  IMAGE_ASPECTS,
  MODELS,
  VIDEO_ASPECTS,
  VIDEO_GENERATION_RESOLUTIONS,
  VIDEO_MODE_COUNTS,
  VIDEO_RESOLUTIONS,
  type FlowRoute,
} from "./index.js";
import { proto, mediaStatus, mediaLink, mediaFailure } from "./rpc.js";
import { classifyFlowError } from "./errors.js";

export class ModelError extends Error {
  code = "INVALID_PARAMETERS";
  outcome = "not_submitted" as const;
  retryable = false;
}
export class FlowError extends Error {
  constructor(
    public code: string,
    message: string,
    public outcome: "not_submitted" | "unknown" = "unknown",
    public retryable?: boolean,
  ) {
    super(message);
    this.name = "FlowError";
  }
}
export interface ImageModel {
  mediaKind: "image";
  key: string;
  aspect: string;
  aspectRatio: number;
  size: string;
  upsampleResolution: number | null;
}
export interface VideoModel {
  mediaKind: "video";
  key: string;
  aspect: string;
  aspectRatio: number;
  size: string;
  upsampleResolution: number | null | undefined;
  upsampleKey?: string | null;
  route: string;
  family: string | null;
  withAudio: boolean;
  audioFailurePreference: number;
  generationSize: string;
  duration: number;
  generationResolution: number;
  priority: string;
}
export type ResolvedModel = ImageModel | VideoModel;

function choice(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
  label: string,
) {
  const normalized = String(value || fallback)
    .trim()
    .toLowerCase();
  if (!allowed.includes(normalized)) {
    throw new ModelError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return normalized;
}
function chooseVideoRoute(
  parameters: Record<string, unknown>,
  inputCount: number,
  routes: Record<string, FlowRoute>,
) {
  const publicModes: Record<string, string> = {
    text: "t2v",
    start: "i2v",
    reference: "r2v",
  };
  const requested = String(
    parameters.mode || parameters.video_mode || parameters.video_route || "",
  )
    .trim()
    .toLowerCase();
  const explicit = publicModes[requested] || requested;
  const inferred =
    inputCount === 0
      ? "t2v"
      : inputCount === 1
        ? "i2v"
        : inputCount === 2 && routes.interpolation
          ? "interpolation"
          : "r2v";
  const route = explicit || inferred;
  if (!routes[route])
    throw new ModelError(`Model does not support ${route} generation`);
  const [minimum, maximum] = VIDEO_MODE_COUNTS[route];
  if (inputCount < minimum || inputCount > maximum) {
    throw new ModelError(
      `${route} generation requires ${minimum}-${maximum} image(s); got ${inputCount}`,
    );
  }
  return route;
}
function chooseVideoKey(
  routeSpec: FlowRoute,
  aspect: string,
  duration: number,
  defaultDuration: number,
  priority: string,
  size: string,
) {
  let key;
  if (routeSpec.keyTemplate) {
    const resolutionSuffix = size === "360p" ? "_360p" : "";
    key = routeSpec.keyTemplate
      .replace("{duration}", String(duration))
      .replace("{resolution_suffix}", resolutionSuffix);
  } else if (routeSpec.duration && duration !== defaultDuration) {
    key = routeSpec.duration.replace("{duration}", String(duration));
  } else {
    key =
      aspect === "portrait" && routeSpec.portrait
        ? routeSpec.portrait
        : routeSpec.key;
  }
  if (priority === "low_priority") key += routeSpec.lowPrioritySuffix;
  return key;
}
export function resolveModel(
  modelId: string,
  mediaKind: string,
  parameters: Record<string, unknown> = {},
  inputCount = 0,
): ResolvedModel {
  const spec = MODELS[modelId];
  if (!spec) throw new ModelError(`Unsupported Flow model: ${modelId}`);
  if (spec.mediaKind !== mediaKind) {
    throw new ModelError(
      `Model ${modelId} produces ${spec.mediaKind}, not ${mediaKind}`,
    );
  }
  if (spec.mediaKind === "image") {
    if (inputCount > spec.maxInputs) {
      throw new ModelError(
        `${modelId} supports at most ${spec.maxInputs} reference images`,
      );
    }
    const aspectInput =
      (
        {
          "16:9": "landscape",
          "9:16": "portrait",
          "1:1": "square",
          "4:3": "four-three",
          "3:4": "three-four",
        } as Record<string, string>
      )[
        String(parameters.aspect || parameters.aspect_ratio || "").toLowerCase()
      ] ||
      parameters.aspect ||
      parameters.aspect_ratio;
    const aspect = choice(
      aspectInput,
      Object.keys(IMAGE_ASPECTS),
      "landscape",
      "aspect",
    );
    const size = choice(
      parameters.size || parameters.image_size,
      spec.sizes,
      "1k",
      "size",
    );
    return {
      mediaKind: spec.mediaKind,
      key: spec.key,
      aspect,
      aspectRatio: IMAGE_ASPECTS[aspect],
      size,
      upsampleResolution: size === "1k" ? null : size === "2k" ? 1 : 2,
    };
  }
  const aspectInput =
    ({ "16:9": "landscape", "9:16": "portrait" } as Record<string, string>)[
      String(parameters.aspect || parameters.aspect_ratio || "").toLowerCase()
    ] ||
    parameters.aspect ||
    parameters.aspect_ratio;
  const aspect = choice(
    aspectInput,
    Object.keys(VIDEO_ASPECTS),
    "landscape",
    "aspect",
  );
  const size = choice(
    parameters.size || parameters.image_size,
    spec.sizes,
    "720p",
    "size",
  );
  const resolutionMode = spec.resolutionModes?.[size] || null;
  const generationSize = resolutionMode?.generationSize || size;
  const route = chooseVideoRoute(parameters, inputCount, spec.routes);
  const routeSpec = spec.routes[route];
  const allowedDurations = routeSpec.durations || spec.durations;
  const requestedDuration = Number(
    parameters.duration_seconds ??
      parameters.durationSeconds ??
      parameters.duration ??
      8,
  );
  if (!allowedDurations.includes(requestedDuration)) {
    throw new ModelError(
      `duration_seconds must be one of: ${allowedDurations.join(", ")}`,
    );
  }
  const duration = requestedDuration;
  if (
    (size === "1080p" || size === "4k") &&
    duration !== 8 &&
    !spec.resolutionModes
  ) {
    throw new ModelError(`${size} video requires duration_seconds=8`);
  }
  const upsample: [number | undefined, string] | null =
    resolutionMode?.upsampleKey
      ? [resolutionMode.upsampleResolution, resolutionMode.upsampleKey]
      : VIDEO_RESOLUTIONS[size] || null;
  const generationResolution =
    VIDEO_GENERATION_RESOLUTIONS[generationSize] ||
    VIDEO_GENERATION_RESOLUTIONS["720p"];
  const priority = choice(
    parameters.priority || parameters.queue_tier,
    ["standard", "low_priority"],
    "standard",
    "priority",
  );
  if (priority === "low_priority" && !routeSpec.lowPrioritySuffix) {
    throw new ModelError(
      `${modelId} does not support a low_priority queue tier for ${route}`,
    );
  }
  //: Veo always tries to score the clip, so the only question Flow lets us
  //: answer is what a *failed* soundtrack should cost. Blocking is right
  //: only when the caller asked for sound: then a silent clip is not the
  //: thing they ordered. When they did not, blocking throws away a finished
  //: video over audio the renderer was going to drop anyway (see
  //: pipeline/steps/render.py, _own_audio).
  const withAudio =
    parameters.with_audio === true || parameters.with_audio === "true";
  return {
    mediaKind: spec.mediaKind,
    route,
    family: spec.family || null,
    withAudio,
    audioFailurePreference: withAudio ? 1 : 2,
    key: chooseVideoKey(
      routeSpec,
      aspect,
      duration,
      8,
      priority,
      generationSize,
    ),
    aspect,
    aspectRatio: VIDEO_ASPECTS[aspect],
    size,
    generationSize,
    duration,
    generationResolution,
    priority,
    upsampleResolution: upsample ? upsample[0] : null,
    upsampleKey: upsample ? upsample[1] : null,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function mediaRows(value: unknown): FlowMedia[] {
  if (value == null) return [];
  if (
    !Array.isArray(value) ||
    value.some((row) => !Array.isArray(row) || typeof row[0] !== "string")
  )
    throw new FlowError(
      "outcome_unknown",
      "Flow returned an invalid media receipt",
    );
  return value as FlowMedia[];
}
function nameOf(row: FlowMedia | undefined) {
  return row?.[0] || "";
}
function mediaUrl(row: FlowMedia) {
  return (
    mediaLink(row) ||
    (row[0] ? "provider-artifact://" + encodeURIComponent(row[0]) : "")
  );
}
function seedOf(row: FlowMedia) {
  return row[6]?.[0]?.[1] ?? row[7]?.[0]?.[1];
}
function throwFailure(row: FlowMedia) {
  const failure = mediaFailure(row);
  if (failure || [4, 5, 7].includes(mediaStatus(row))) {
    const error = classifyFlowError({
      status: null,
      rawText: JSON.stringify({ error: failure }),
      generationFailed: true,
    });
    throw new FlowError(
      error?.code || "GENERATION_FAILED",
      error?.summary || "Google Flow generation failed",
    );
  }
}
function bytesBase64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(text);
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
interface PromptInput {
  prompt: string;
  images: Array<{ source: string; mimeType?: string; role: string }>;
}
function promptInput(prompt: MediaPrompt): PromptInput {
  if (typeof prompt === "string") return { prompt, images: [] };
  const texts: string[] = [],
    images: PromptInput["images"] = [];
  for (const part of prompt) {
    if (part.type === "text") {
      texts.push(part.content);
      continue;
    }
    if (part.type !== "image")
      throw new ModelError("Flow conditioning accepts images only");
    if (part.source.type === "file")
      throw new ModelError("Flow cannot use provider file handles");
    const role = part.metadata?.role || "reference";
    if (!["reference", "start_frame", "end_frame"].includes(role))
      throw new ModelError("Unsupported Flow image role: " + role);
    const source =
      part.source.type === "data"
        ? `data:${part.source.mimeType};base64,${part.source.value}`
        : part.source.value;
    images.push({
      source,
      role,
      ...(part.source.mimeType ? { mimeType: part.source.mimeType } : {}),
    });
  }
  return { prompt: texts.join("\n"), images };
}
export interface FlowBatchItem {
  prompt: MediaPrompt;
  seed?: number;
}
interface ImageItem extends PromptInput {
  seed: number;
}
export interface FlowServiceOptions {
  requestRpc: (
    rpc: FlowRpcDescriptor,
    signal: AbortSignal,
  ) => Promise<FlowPageResponse>;
  executeCaptcha: (
    action: string,
    projectId: string,
    signal: AbortSignal,
  ) => Promise<string>;
  verifyAccount: (expected: string) => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** Each method executes only the work explicitly requested by this invocation. */
export class FlowService {
  private fetch: typeof globalThis.fetch;
  private sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(private dependencies: FlowServiceOptions) {
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = dependencies.sleep ?? wait;
  }
  private async request(
    id: string,
    data: unknown[],
    signal: AbortSignal,
  ): Promise<unknown[]> {
    signal.throwIfAborted();
    const response = await this.dependencies.requestRpc({ id, data }, signal);
    signal.throwIfAborted();
    if (!response.ok) {
      if (response.status === 0)
        throw new FlowError(
          "outcome_unknown",
          response.error || "Google Flow request outcome unknown",
        );
      const reason = classifyFlowError({
        status: response.status,
        rawText: response.raw || "",
      });
      // A rejection of the original generation RPC is not a lost receipt.
      // Never apply this to polling/upsampling after media was already accepted.
      // Multi-item batches stay conservative: no replay of partially accepted work.
      const generation = ["YhhmEf", "eb1hJf", "nprQif", "MZZa6b"].includes(id) ||
        (id === "ogiZ0b" && Array.isArray(data[1]) && data[1].length === 1);
      const rejected = generation && ["FLOW_CAPACITY", "FLOW_ACCOUNT_THROTTLED", "FLOW_AUTH_REJECTED", "FLOW_MODEL_ACCESS_DENIED", "FLOW_MODEL_DAILY_QUOTA_REACHED", "FLOW_PER_MODEL_DAILY_QUOTA_REACHED", "FLOW_USER_QUOTA_REACHED", "FLOW_WORKSPACE_QUOTA_REACHED"].includes(reason?.code ?? "");
      throw new FlowError(
        reason?.code || "UPSTREAM_" + response.status,
        reason?.summary || "Google Flow returned HTTP " + response.status,
        rejected ? "not_submitted" : "unknown",
        rejected ? true : undefined,
      );
    }
    if (!Array.isArray(response.data))
      throw new FlowError(
        "outcome_unknown",
        "Flow returned an invalid RPC receipt",
      );
    return response.data;
  }
  private async project(context: ProviderContext): Promise<string> {
    await this.dependencies.verifyAccount(context.accountSubject);
    const result = await this.request(
      "jHPbke",
      [
        "projects/*",
        [null, ["Browser2API " + new Date().toISOString()]],
        [null, 22],
      ],
      context.signal,
    );
    const projectId =
      typeof result[0] === "string" ? result[0].split("/").pop() : undefined;
    if (!projectId)
      throw new FlowError(
        "UPSTREAM_RESPONSE_INVALID",
        "Flow returned no project id",
      );
    return projectId;
  }
  private async clientContext(
    action: string,
    projectId: string,
    signal: AbortSignal,
    tier?: unknown,
  ) {
    const token = await this.dependencies.executeCaptcha(
      action,
      projectId,
      signal,
    );
    signal.throwIfAborted();
    return proto({
      2: 22,
      6: projectId,
      7: typeof tier === "number" ? tier : undefined,
      11: [token, 1],
    });
  }
  private async upload(
    input: PromptInput["images"][number],
    projectId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const response = await this.fetch(input.source, {
      signal,
      credentials: "omit",
    });
    if (!response.ok)
      throw new FlowError(
        "INPUT_DOWNLOAD_FAILED",
        `Reference returned HTTP ${response.status}`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    const result = await this.request(
      "maseQ",
      proto({
        1: proto({ 2: 22, 6: projectId }),
        2: bytesBase64(bytes),
        3:
          input.mimeType || response.headers.get("content-type") || "image/png",
        4: 1,
        8: 0,
        9: crypto.randomUUID() + ".png",
      }),
      signal,
    );
    const name = nameOf(mediaRows(result)[0]);
    if (!name)
      throw new FlowError(
        "UPLOAD_RESPONSE_INVALID",
        "Flow reference upload returned no media id",
      );
    return name;
  }
  async generateImages(
    options: Pick<
      ImageGenerationOptions<SiteModelOptions>,
      "model" | "prompt" | "size" | "numberOfImages" | "modelOptions"
    >,
    context: ProviderContext,
  ): Promise<ImageGenerationResult> {
    const modelOptions = object(options.modelOptions),
      batch = modelOptions.batch;
    let requests: FlowBatchItem[];
    if (batch !== undefined) {
      if (!Array.isArray(batch) || !batch.length)
        throw new ModelError("Flow batch must contain requested items");
      requests = batch.map((raw) => {
        const item = object(raw);
        if (typeof item.prompt !== "string" && !Array.isArray(item.prompt))
          throw new ModelError("Flow batch item requires a media prompt");
        return {
          prompt: item.prompt as MediaPrompt,
          ...(Number.isSafeInteger(item.seed)
            ? { seed: Number(item.seed) }
            : {}),
        };
      });
      if (
        options.numberOfImages !== undefined &&
        options.numberOfImages !== requests.length
      )
        throw new ModelError(
          "numberOfImages must match the number of explicit batch items",
        );
    } else {
      const count = options.numberOfImages ?? 1;
      if (!Number.isInteger(count) || count < 1)
        throw new ModelError("numberOfImages must be positive");
      requests = Array.from({ length: count }, () => ({
        prompt: options.prompt,
        ...(Number.isSafeInteger(modelOptions.seed)
          ? { seed: Number(modelOptions.seed) }
          : {}),
      }));
    }
    const items: ImageItem[] = requests.map((item) => ({
      ...promptInput(item.prompt),
      seed: item.seed ?? Math.floor(Math.random() * 2147483647),
    }));
    if (items.some((item) => !item.prompt.trim()))
      throw new ModelError("Flow image prompts must not be empty");
    const model = resolveModel(
      options.model,
      "image",
      { ...modelOptions, size: options.size ?? modelOptions.size },
      Math.max(...items.map((item) => item.images.length)),
    );
    if (model.mediaKind !== "image")
      throw new ModelError("Expected image model");
    const projectId = await this.project(context),
      signal = context.signal;
    const balance = model.upsampleResolution
      ? await this.request("nzlxg", [], signal)
      : [];
    if (model.size === "4k" && balance[1] !== 2)
      throw new FlowError(
        "FLOW_ULTRA_REQUIRED",
        "Google Flow 4K images require an Ultra account",
      );
    const uploadCache = new Map<string, Promise<string>>();
    const inputSets: string[][] = [];
    for (const item of items) {
      const inputs: string[] = [];
      for (const input of item.images) {
        let pending = uploadCache.get(input.source);
        if (!pending) {
          pending = this.upload(input, projectId, signal);
          uploadCache.set(input.source, pending);
        }
        inputs.push(await pending);
      }
      inputSets.push(inputs);
    }
    const clientContext = await this.clientContext(
      "IMAGE_GENERATION",
      projectId,
      signal,
    );
    const receipt = await this.request(
      "ogiZ0b",
      proto({
        2: items.map((item, index) =>
          proto({
            3: inputSets[index].length
              ? inputSets[index].map((name) => proto({ 1: name, 5: 1 }))
              : undefined,
            4: item.seed,
            5: model.aspectRatio,
            6: model.key,
            8: clientContext,
            9: [[[item.prompt]]],
            13: crypto.randomUUID(),
            14: crypto.randomUUID(),
          }),
        ),
        3: 1,
        4: clientContext,
        5: [crypto.randomUUID()],
      }),
      signal,
    );
    const media = mediaRows(receipt[0]);
    if (media.length !== items.length)
      throw new FlowError(
        "outcome_unknown",
        "Flow returned an incomplete image batch receipt",
      );
    const images: GeneratedImage[] = [];
    const used = new Set<FlowMedia>();
    for (let index = 0; index < items.length; index++) {
      const matching = media.filter(
        (row) => seedOf(row) === items[index].seed && !used.has(row),
      );
      const row = matching.length === 1 ? matching[0] : media[index];
      if (used.has(row))
        throw new FlowError(
          "outcome_unknown",
          "Flow batch images could not be matched",
        );
      used.add(row);
      throwFailure(row);
      if (model.upsampleResolution) {
        const name = nameOf(row);
        if (!name)
          throw new FlowError(
            "outcome_unknown",
            "Flow image has no upscale source",
          );
        if (mediaStatus(row) !== 3)
          throw new FlowError("outcome_unknown", "Flow base image is not ready for upscale");
        if (context.upscaleReady && !(await context.upscaleReady()))
          throw new FlowError("UPSCALE_WINDOW_EXPIRED", "The upscale window is no longer active", "unknown", false);
        const upscaleContext = await this.clientContext(
          "IMAGE_GENERATION",
          projectId,
          signal,
          balance[1],
        );
        const upscale = await this.request(
          "SPrCad",
          [name, model.upsampleResolution, upscaleContext],
          signal,
        );
        if (typeof upscale[1] !== "string" || !upscale[1])
          throw new FlowError(
            "outcome_unknown",
            "Flow image upscale returned no bytes",
          );
        images.push({ b64Json: upscale[1] });
      } else {
        const url = mediaUrl(row);
        if (!url)
          throw new FlowError(
            "outcome_unknown",
            "Flow returned an image with no media",
          );
        images.push({ url });
      }
    }
    await this.dependencies.verifyAccount(context.accountSubject);
    return { id: context.requestId, model: options.model, images };
  }
  private async poll(
    name: string,
    initial: FlowMedia,
    signal: AbortSignal,
  ): Promise<FlowMedia> {
    let row = initial;
    const deadline = Date.now() + 7 * 60 * 1000;
    while (true) {
      signal.throwIfAborted();
      throwFailure(row);
      if (mediaStatus(row) === 3) return row;
      if (Date.now() >= deadline)
        throw new FlowError(
          "outcome_unknown",
          "Google Flow video wait expired",
        );
      await this.sleep(1500, signal);
      const receipt = await this.request(
        "jwpduf",
        [null, null, [[name]]],
        signal,
      );
      const values = mediaRows(receipt[2]);
      const current =
        values.find((item) => nameOf(item) === name) ||
        (values.length === 1 ? values[0] : undefined);
      if (current) row = current;
    }
  }
  async generateVideo(
    options: Pick<
      VideoGenerationOptions<SiteModelOptions>,
      "model" | "prompt" | "size" | "duration" | "modelOptions"
    >,
    context: ProviderContext,
  ): Promise<VideoUrlResult> {
    const input = promptInput(options.prompt),
      parameters = object(options.modelOptions);
    if (!input.prompt.trim())
      throw new ModelError("Flow video prompt must not be empty");
    const references = input.images.filter(
        (image) => image.role === "reference",
      ),
      start = input.images.filter((image) => image.role === "start_frame"),
      end = input.images.filter((image) => image.role === "end_frame");
    if (
      (references.length && (start.length || end.length)) ||
      start.length > 1 ||
      end.length > 1 ||
      (end.length && !start.length)
    )
      throw new ModelError(
        "Flow video inputs require references or an ordered start/end pair",
      );
    const mode = references.length
      ? "reference"
      : end.length
        ? "interpolation"
        : start.length
          ? "start"
          : "text";
    const ordered = references.length ? references : [...start, ...end];
    const model = resolveModel(
      options.model,
      "video",
      {
        ...parameters,
        mode,
        size: options.size ?? parameters.size,
        duration: options.duration ?? parameters.duration,
      },
      ordered.length,
    );
    if (model.mediaKind !== "video")
      throw new ModelError("Expected video model");
    const projectId = await this.project(context),
      signal = context.signal;
    const balance = await this.request("nzlxg", [], signal);
    if (Number(balance[0]) === 0)
      throw new FlowError(
        "FLOW_CREDITS_EXHAUSTED",
        "Google Flow has no video credits",
      );
    if (model.size === "4k" && balance[1] !== 2)
      throw new FlowError(
        "FLOW_ULTRA_REQUIRED",
        "Google Flow 4K requires an Ultra account",
      );
    if (
      ["1080p", "720p_economy"].includes(model.size) &&
      ![1, 2].includes(Number(balance[1]))
    )
      throw new FlowError(
        "FLOW_PAID_REQUIRED",
        "This Flow video upscale requires a paid account",
      );
    const uploaded: string[] = [];
    for (const image of ordered)
      uploaded.push(await this.upload(image, projectId, signal));
    const clientContext = await this.clientContext(
      "VIDEO_GENERATION",
      projectId,
      signal,
      balance[1],
    );
    const seed = Number.isSafeInteger(parameters.seed)
      ? Number(parameters.seed)
      : Math.floor(Math.random() * 2147483647);
    const metadata = proto({ 5: crypto.randomUUID(), 6: crypto.randomUUID() });
    const text = proto({ 3: [[[input.prompt]]] });
    const image = (index: number) =>
      proto({ 2: uploaded[index], 6: proto({ 3: 1, 4: 1 }) });
    const request =
      model.route === "r2v"
        ? proto({
            1: text,
            2: uploaded.map((id) => [null, id]),
            3: model.key,
            4: model.aspectRatio,
            5: seed,
            6: metadata,
            12: [model.generationResolution],
          })
        : proto({
            1: text,
            2: model.key,
            3: model.aspectRatio,
            4: seed,
            ...(model.route === "t2v"
              ? { 5: metadata, 8: [model.generationResolution] }
              : model.route === "i2v"
                ? { 5: image(0), 6: metadata, 10: [model.generationResolution] }
                : { 5: image(0), 6: image(1), 7: metadata }),
          });
    const rpcIds: Record<string, string> = {
      t2v: "YhhmEf",
      i2v: "eb1hJf",
      interpolation: "nprQif",
      r2v: "MZZa6b",
    };
    const receipt = await this.request(
      rpcIds[model.route],
      [
        [request],
        clientContext,
        [crypto.randomUUID(), model.audioFailurePreference],
      ],
      signal,
    );
    const accepted = mediaRows(receipt[3])[0];
    const name = nameOf(accepted);
    if (!name)
      throw new FlowError(
        "outcome_unknown",
        "Flow returned no video operation",
      );
    let result = await this.poll(name, accepted, signal);
    if (model.upsampleKey) {
      const source = nameOf(result) || name;
      if (context.upscaleReady && !(await context.upscaleReady()))
        throw new FlowError("UPSCALE_WINDOW_EXPIRED", "The upscale window is no longer active", "unknown", false);
      const upscaleContext = await this.clientContext(
        "VIDEO_GENERATION",
        projectId,
        signal,
        balance[1],
      );
      const upscale = await this.request(
        "p0UkFb",
        [
          [
            proto({
              1: [null, source],
              3: model.aspectRatio,
              4: Math.floor(Math.random() * 2147483647),
              5: proto({ 2: String(result[2] || ""), 5: crypto.randomUUID() }),
              7: model.upsampleResolution,
              32: model.upsampleKey,
            }),
          ],
          upscaleContext,
          [crypto.randomUUID()],
        ],
        signal,
      );
      const row = mediaRows(upscale[3])[0];
      const upscaleName = nameOf(row);
      if (!upscaleName)
        throw new FlowError(
          "outcome_unknown",
          "Flow returned no upscale operation",
        );
      result = await this.poll(upscaleName, row, signal);
    }
    await this.dependencies.verifyAccount(context.accountSubject);
    const url = mediaUrl(result);
    if (!url)
      throw new FlowError(
        "outcome_unknown",
        "Flow completed video has no media URL",
      );
    return { jobId: context.requestId, url };
  }
  async fetchArtifact(
    url: string,
    signal: AbortSignal,
  ): Promise<ProviderMediaBody> {
    if (url.startsWith("provider-artifact://")) {
      const name = decodeURIComponent(url.slice("provider-artifact://".length));
      const result = mediaRows([
        await this.request("as29s", [name], signal),
      ])[0];
      const encoded = result[7]?.[0]?.[0] || result[6]?.[0]?.[0];
      if (typeof encoded === "string") {
        const bytes = Uint8Array.from(atob(encoded), (character) =>
          character.charCodeAt(0),
        );
        return {
          body: bytes,
          mimeType: result[7]?.[0] ? "video/mp4" : "image/png",
          size: bytes.byteLength,
        };
      }
      const link = mediaLink(result);
      if (link) return this.fetchArtifact(link, signal);
      throw new FlowError(
        "ARTIFACT_NOT_FOUND",
        "Flow media has no downloadable content",
      );
    }
    const parsed = new URL(url);
    const suffixes = [
      "googleusercontent.com",
      "googleapis.com",
      "googlevideo.com",
      "gstatic.com",
      "ggpht.com",
      "flow-content.google",
    ];
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !suffixes.some(
        (suffix) =>
          parsed.hostname === suffix || parsed.hostname.endsWith("." + suffix),
      )
    )
      throw new FlowError(
        "ARTIFACT_ORIGIN_NOT_ALLOWED",
        "Not a Google Flow artifact origin",
      );
    const response = await this.fetch(url, { signal, credentials: "include" });
    if (!response.ok || !response.body)
      throw new FlowError(
        "ARTIFACT_DOWNLOAD_FAILED",
        `Flow artifact returned HTTP ${response.status}`,
      );
    return {
      body: response.body,
      mimeType:
        response.headers.get("content-type") || "application/octet-stream",
      size: Number(response.headers.get("content-length") || 0),
    };
  }
}
