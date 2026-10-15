import { type ImageGenerationResult, type AudioGenerationResult } from "@tanstack/ai";
import { UPLOAD_PATH, type SDKResult, uploadedFileSchema } from "../../shared/contracts.js";
import { type ProviderAdapter, type ProviderContext, type ProviderMediaBody, type Settings } from "./runtime.js";

export async function uploadResult(
  settings: Readonly<Settings>,
  provider: ProviderAdapter,
  kind: string,
  result: SDKResult,
  context: ProviderContext,
): Promise<SDKResult> {
  if (kind === "image") {
    const media = result as ImageGenerationResult;
    return {
      ...media,
      images: await Promise.all(
        media.images.map(async (image) => {
          const { url, b64Json, ...extra } = image;
          const contentType = (image as { contentType?: unknown }).contentType;
          return {
            ...extra,
            url: await upload(
              settings,
              provider,
              context,
              url,
              b64Json,
              typeof contentType === "string" ? contentType : "image/png",
            ),
          };
        }),
      ),
    };
  }
  if (kind === "audio") {
    const media = result as AudioGenerationResult;
    const { url, b64Json, ...extra } = media.audio;
    return {
      ...media,
      audio: {
        ...extra,
        url: await upload(
          settings,
          provider,
          context,
          url,
          b64Json,
          media.audio.contentType || "audio/wav",
        ),
      },
    };
  }
  if (
    kind === "video" &&
    result &&
    typeof result === "object" &&
    "url" in result &&
    typeof result.url === "string"
  )
    return {
      ...result,
      url: await upload(
        settings,
        provider,
        context,
        result.url,
        undefined,
        "video/mp4",
      ),
    };
  return result;
}
async function upload(
  settings: Readonly<Settings>,
  provider: ProviderAdapter,
  context: ProviderContext,
  url: string | undefined,
  b64: string | undefined,
  mimeType: string,
) {
  const { body, mimeType: contentType } = await collect(provider, context, url, b64, mimeType);
  context.signal.throwIfAborted();
  const response = await fetch(settings.serverOrigin + UPLOAD_PATH, {
    method: "POST",
    signal: context.signal,
    headers: {
      Authorization: "Bearer " + settings.token,
      "X-Profile-Id": settings.profileId,
      "X-Request-Id": context.requestId,
      "Content-Type": contentType,
    },
    body,
  });
  // A failed upload never triggers another generation or an ambiguous POST replay.
  if (!response.ok)
    throw new Error("Host media upload failed: " + response.status);
  const stored = uploadedFileSchema.parse(await response.json());
  return new URL(stored.url, settings.serverOrigin).href;
}
async function collect(
  provider: ProviderAdapter,
  context: ProviderContext,
  url: string | undefined,
  b64: string | undefined,
  mimeType: string,
) {
  for (let attempt = 0; ; attempt++) {
    context.signal.throwIfAborted();
    try {
  let source: ProviderMediaBody;
  if (b64 !== undefined) {
    const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) mimeType = "image/jpeg";
    source = { body: new Blob([bytes], { type: mimeType }), mimeType };
  } else if (url && provider.fetchArtifact)
    source = await provider.fetchArtifact(url, context.signal);
  else if (url) {
    const response = await fetch(url, { signal: context.signal });
    if (!response.ok || !response.body)
      throw new Error("Media download failed");
    source = {
      body: response.body,
      mimeType: response.headers.get("content-type") || mimeType,
    };
  } else throw new Error("Provider returned no media source");
  // Chromium rejects ReadableStream upload bodies over HTTP/1.x (including
  // the local Hono server). A Blob works on both local HTTP and production HTTPS.
  const body =
    source.body instanceof ReadableStream
      ? await new Response(source.body).blob()
      : source.body instanceof Uint8Array
        ? new Blob([source.body as Uint8Array<ArrayBuffer>])
        : source.body;
      if (!body.size || /^(text\/html|application\/(?:json|problem\+json))(?:;|$)/i.test(source.mimeType))
        throw Object.assign(Error("Provider returned an empty file or an error document instead of media"), { code: "ARTIFACT_INVALID", retryable: false });
      return { body, mimeType: source.mimeType };
    } catch (error) {
      // Retry only reading the exact original artifact, including interrupted bodies.
      if (attempt || context.signal.aborted || b64 !== undefined || !url) throw error;
    }
  }
}
