import type { Hono, Context } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ImagesResponse } from "openai/resources/images";
import {
  jsonObjectSchema,
  VOICES,
  voiceCatalog,
  VOICE_PREVIEW_LANGUAGES,
  modelSpec,
  parseSDKRequest,
  type RequestRecord,
  type SDKRequest,
} from "../shared/contracts.js";
import { BrowserDispatcher } from "./runtime.js";
import { FileStore, fileResponse } from "./files.js";
import { ServiceError, apiError, requestServiceError } from "./errors.js";

const modelOptions = {
  model: z.string().min(1),
  provider_options: jsonObjectSchema.optional(),
};
const images = z.object({
  ...modelOptions,
  prompt: z.unknown(),
  n: z.number().int().positive().optional(),
  size: z.string().optional(),
  response_format: z.enum(["url", "b64_json"]).optional(),
  stream: z.literal(false).optional(),
});
const speech = z.object({
  ...modelOptions,
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.literal("wav").optional(),
  speed: z.literal(1).optional(),
  stream_format: z.enum(["audio", "sse"]).optional(),
});
const videos = z.object({
  ...modelOptions,
  prompt: z.unknown(),
  size: z.string().optional(),
  seconds: z.union([z.string(), z.number().positive()]).optional(),
});

/** OpenAI pixel dimensions and native vendor sizes share one request boundary. */
export function mediaSize(
  kind: "image" | "video",
  size: string | undefined,
  options: Record<string, unknown> = {},
) {
  if (size === undefined || size === "auto")
    return { size: undefined, modelOptions: options };
  const dimensions = /^(\d+)x(\d+)$/.exec(size);
  if (!dimensions) return { size, modelOptions: options };
  const width = Number(dimensions[1]),
    height = Number(dimensions[2]);
  if (!width || !height)
    throw new ServiceError(
      "Invalid media dimensions",
      400,
      "invalid_size",
      "size",
    );
  const ratio = width / height;
  const aspects =
    kind === "image"
      ? ([
          [1, "square"],
          [16 / 9, "landscape"],
          [9 / 16, "portrait"],
          [4 / 3, "four-three"],
          [3 / 4, "three-four"],
        ] as const)
      : ([
          [16 / 9, "landscape"],
          [9 / 16, "portrait"],
        ] as const);
  const aspect = aspects.find(([value]) => Math.abs(value - ratio) < 0.01)?.[1];
  if (!aspect)
    throw new ServiceError(
      "Provider does not support these dimensions",
      400,
      "invalid_size",
      "size",
    );
  const edge = Math.max(width, height),
    short = Math.min(width, height);
  const native =
    kind === "image"
      ? edge <= 1536
        ? "1k"
        : edge <= 3072
          ? "2k"
          : "4k"
      : short === 360
        ? "360p"
        : short === 720
          ? "720p"
          : short === 1080
            ? "1080p"
            : short === 2160
              ? "4k"
              : undefined;
  if (!native)
    throw new ServiceError(
      "Provider does not support this resolution",
      400,
      "invalid_size",
      "size",
    );
  return { size: native, modelOptions: { ...options, aspect } };
}

export function mountMedia(
  app: Hono,
  host: BrowserDispatcher,
  files: FileStore,
) {
  function artifact(record: RequestRecord, url: unknown) {
    if (typeof url !== "string")
      throw new ServiceError(
        "Provider returned no file",
        502,
        "invalid_provider_response",
      );
    const match = /^\/v1\/files\/([^/]+)$/.exec(
      new URL(url, "http://localhost").pathname,
    );
    const file = match && files.get(match[1]);
    if (!file || file.requestId !== record.id)
      throw new ServiceError(
        "Provider result file is unavailable",
        502,
        "invalid_provider_response",
      );
    return file;
  }
  async function body(c: Context) {
    if (!c.req.header("content-type")?.includes("multipart/form-data"))
      return { value: await c.req.json(), form: undefined };
    const form = await c.req.formData();
    const value: Record<string, unknown> = {};
    for (const [key, item] of form)
      if (typeof item === "string") {
        value[key] = ["provider_options"].includes(key)
          ? JSON.parse(item)
          : key === "n"
            ? Number(item)
            : item;
      }
    return { value, form };
  }
  async function imagePart(file: Blob, role: string) {
    if (!file.type.startsWith("image/"))
      throw new ServiceError("Image file required", 400, "invalid_image");
    return {
      type: "image",
      source: {
        type: "data",
        value: Buffer.from(await file.arrayBuffer()).toString("base64"),
        mimeType: file.type,
      },
      metadata: { role },
    };
  }
  async function generateImages(c: Context) {
    const { value, form } = await body(c),
      input = images.parse(value);
    let prompt = input.prompt;
    if (c.req.path.endsWith("/edits")) {
      const references = [
        ...(form?.getAll("image") ?? []),
        ...(form?.getAll("image[]") ?? []),
      ];
      if (
        !references.length ||
        references.some((file) => !(file instanceof Blob))
      )
        throw new ServiceError(
          "Image edits require multipart image files",
          400,
          "invalid_image",
          "image",
        );
      const parts = await Promise.all(
        (references as Blob[]).map((file) => imagePart(file, "reference")),
      );
      const mask = form?.get("mask");
      if (mask instanceof Blob) parts.push(await imagePart(mask, "mask"));
      prompt = [{ type: "text", content: z.string().parse(prompt) }, ...parts];
    }
    const request = parseSDKRequest({
      kind: "image",
      options: {
        model: input.model,
        prompt,
        numberOfImages: input.n,
        ...mediaSize("image", input.size, input.provider_options),
      },
    });
    const record = await host.execute(request, c.req.raw.signal);
    const result = record.result as {
      images?: Array<{
        url?: string;
        b64Json?: string;
        revisedPrompt?: string;
      }>;
      id?: string;
      model?: string;
      [key: string]: unknown;
    };
    if (!Array.isArray(result?.images) || !result.images.length)
      throw new ServiceError(
        "Provider returned no images",
        502,
        "invalid_provider_response",
      );
    const data = await Promise.all(
      result.images.map(async (image) => ({
        ...(input.response_format === "b64_json"
          ? {
              b64_json: Buffer.from(
                await readFile(artifact(record, image.url).path),
              ).toString("base64"),
            }
          : { url: image.url }),
        ...(image.revisedPrompt ? { revised_prompt: image.revisedPrompt } : {}),
      })),
    );
    const { images: _images, ...metadata } = result;
    c.header("x-request-id", record.id);
    return c.json({
      created: Math.floor(Date.parse(record.createdAt) / 1000),
      data,
      provider_metadata: metadata,
    } satisfies ImagesResponse & { provider_metadata: unknown });
  }
  app.post("/v1/images/generations", generateImages);
  app.post("/v1/images/edits", generateImages);
  app.post("/v1/audio/speech", async (c) => {
    const raw = await c.req.json();
    if (raw.turns?.length || raw.timestamps)
      throw new ServiceError(
        "Google Vids does not return dialogue/alignment metadata",
        400,
        "unsupported_parameter",
      );
    const input = speech.parse(raw);
    const definition = modelSpec(input.model);
    const voice = input.voice ?? definition?.defaultVoice;
    if (!voice || !VOICES.some((item) => item.id === voice))
      throw new ServiceError("Voice not found", 400, "invalid_voice", "voice");
    const record = await host.execute(
      parseSDKRequest({
        kind: "audio",
        options: {
          model: input.model,
          prompt: input.input,
          modelOptions: { ...input.provider_options, voice },
        },
      }),
      c.req.raw.signal,
    );
    const result = record.result as {
      audio?: { url?: string };
      [key: string]: unknown;
    };
    const file = artifact(record, result?.audio?.url);
    c.header("x-request-id", record.id);
    if (input.stream_format !== "sse") {
      const response = await fileResponse(file.path, file.mimeType);
      response.headers.set("x-request-id", record.id);
      return response;
    }
    const metadata = {
      id: record.id,
      model: input.model,
      format: "wav",
      contentType: file.mimeType,
    };
    const encoder = new TextEncoder();
    const reader = (
      await fileResponse(file.path, file.mimeType)
    ).body!.getReader();
    let remaining: Buffer = Buffer.alloc(0);
    return new Response(
      new ReadableStream({
        async pull(controller) {
          const chunk = await reader.read();
          const bytes = Buffer.concat([
            remaining,
            chunk.done ? Buffer.alloc(0) : Buffer.from(chunk.value),
          ]);
          const end = chunk.done
            ? bytes.length
            : bytes.length - (bytes.length % 3);
          remaining = bytes.subarray(end);
          if (end)
            controller.enqueue(
              encoder.encode(
                `event: speech.audio.delta\ndata: ${JSON.stringify({ type: "speech.audio.delta", audio: bytes.subarray(0, end).toString("base64") })}\n\n`,
              ),
            );
          if (chunk.done) {
            controller.enqueue(
              encoder.encode(
                `event: speech.audio.done\ndata: ${JSON.stringify({ type: "speech.audio.done", provider_metadata: metadata })}\n\n`,
              ),
            );
            controller.close();
          }
        },
        cancel: (reason) => reader.cancel(reason),
      }),
      {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": record.id,
          "cache-control": "no-store",
        },
      },
    );
  });
  app.get("/v1/audio/voices", (c) => {
    if (modelSpec(c.req.query("model") ?? "")?.kind !== "audio")
      throw new ServiceError("Speech model not found", 404, "model_not_found");
    const origins = c.req.query("origins")?.split(",");
    return c.json({
      voices:
        origins && !origins.includes("premade")
          ? []
          : voiceCatalog(c.req.query("language")),
      preview_languages: VOICE_PREVIEW_LANGUAGES,
    });
  });
  app.post("/v1/videos", async (c) => {
    c.req.raw.signal.throwIfAborted();
    const { value, form } = await body(c),
      input = videos.parse(value);
    let prompt = input.prompt;
    const reference = form?.get("input_reference");
    if (reference instanceof Blob)
      prompt = [
        { type: "text", content: z.string().parse(prompt) },
        await imagePart(reference, "start_frame"),
      ];
    const seconds =
      input.seconds === undefined ? undefined : Number(input.seconds);
    const request = parseSDKRequest({
      kind: "video",
      options: {
        model: input.model,
        prompt,
        duration: seconds,
        ...mediaSize("video", input.size, input.provider_options),
      },
    });
    const record = host.submit(request);
    c.header("x-request-id", record.id);
    return c.json(videoEnvelope(record), 200);
  });
  function video(id: string) {
    const record = host.store.getRequest(id);
    if (!record || record.request.kind !== "video")
      throw new ServiceError("Video not found", 404, "video_not_found");
    return record;
  }
  app.get("/v1/videos/:id", (c) => {
    const record = video(c.req.param("id"));
    c.header("x-request-id", record.id);
    return c.json(videoEnvelope(record));
  });
  app.get("/v1/videos/:id/content", async (c) => {
    const record = video(c.req.param("id"));
    c.header("x-request-id", record.id);
    if (record.status === "error") throw requestServiceError(record);
    if (record.status !== "completed")
      throw new ServiceError(
        record.error?.message ?? "Video is not completed",
        409,
        record.error?.code ?? "video_not_ready",
      );
    const file = artifact(record, (record.result as { url?: string })?.url);
    const response = await fileResponse(file.path, file.mimeType, c.req.header("range"));
    response.headers.set("x-request-id", record.id);
    return response;
  });
}

export function videoEnvelope(record: RequestRecord) {
  const options = record.request.options as Extract<
    SDKRequest,
    { kind: "video" }
  >["options"];
  return {
    id: record.id,
    object: "video" as const,
    model: options.model,
    created_at: Math.floor(Date.parse(record.createdAt) / 1000),
    status:
      record.status === "pending"
        ? "queued"
        : record.status === "running"
          ? "in_progress"
          : record.status === "completed"
            ? "completed"
            : "failed",
    progress: record.status === "completed" ? 100 : 0,
    ...(options.duration === undefined
      ? {}
      : { seconds: String(options.duration) }),
    ...(options.size ? { size: options.size } : {}),
    error: record.error
      ? apiError(requestServiceError(record)).body.error
      : null,
  };
}
