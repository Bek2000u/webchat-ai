import { type ProviderFailure } from "../../runtime/runtime.js";
import { type AudioSource, TTS_CHUNK_CHARS, TTS_MAX_CHARS } from "./index.js";

const MAX_PART_BYTES = 40 * 1024 * 1024;
const MAX_WAV_BYTES = 640 * 1024 * 1024;

function invalidWav(message: string) {
  const error: ProviderFailure = new Error(message);
  error.code = "GOOGLE_VIDS_WAV_INVALID";
  error.submitted = true;
  return error;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function parseWav(value: Uint8Array | ArrayBuffer) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (
    bytes.length < 44 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WAVE"
  ) {
    throw invalidWav("Google Vids returned an invalid WAV file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format = null;
  const data = [];
  let length = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length)
      throw invalidWav("Google Vids WAV has a truncated chunk");
    if (kind === "fmt ") format = bytes.slice(start, end);
    if (kind === "data") {
      data.push(bytes.subarray(start, end));
      length += size;
    }
    offset = end + (size % 2);
  }
  if (!format || format.length < 16 || !length || !data.length) {
    throw invalidWav("Google Vids WAV has no PCM audio");
  }
  const fmt = new DataView(format.buffer, format.byteOffset, format.byteLength);
  if (fmt.getUint16(0, true) !== 1 || fmt.getUint16(14, true) !== 16) {
    throw invalidWav("Google Vids WAV format is not 16-bit PCM");
  }
  const blockAlign = fmt.getUint16(12, true);
  if (!blockAlign || length % blockAlign !== 0) {
    throw invalidWav("Google Vids WAV samples are misaligned");
  }
  return { format, data, length };
}

function joinedParts(values: (Uint8Array | ArrayBuffer)[]) {
  if (!Array.isArray(values) || !values.length) {
    throw invalidWav("Google Vids returned no audio parts");
  }
  const parts = values.map(parseWav);
  const format = parts[0].format;
  if (
    parts.some(
      (part) =>
        part.format.length !== format.length ||
        part.format.some((byte, index) => byte !== format[index]),
    )
  ) {
    throw invalidWav("Google Vids audio parts use different WAV formats");
  }
  const dataLength = parts.reduce((sum, part) => sum + part.length, 0);
  const formatPadding = format.length % 2;
  const dataPadding = dataLength % 2;
  const totalLength =
    12 + 8 + format.length + formatPadding + 8 + dataLength + dataPadding;
  if (totalLength > MAX_WAV_BYTES) {
    const error = invalidWav("Google Vids combined audio exceeds 640 MiB");
    error.code = "GOOGLE_VIDS_AUDIO_TOO_LARGE";
    throw error;
  }
  const header = new Uint8Array(totalLength - dataLength - dataPadding);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      header[offset + index] = text.charCodeAt(index);
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, totalLength - 8, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, format.length, true);
  header.set(format, 20);
  const dataHeader = 20 + format.length + formatPadding;
  writeAscii(dataHeader, "data");
  view.setUint32(dataHeader + 4, dataLength, true);
  return { header, parts, dataLength, dataPadding, totalLength };
}

export function joinGoogleVidsWavs(values: (Uint8Array | ArrayBuffer)[]) {
  const { header, parts, totalLength } = joinedParts(values);
  const output = new Uint8Array(totalLength);
  output.set(header);
  let cursor = header.length;
  for (const part of parts) {
    for (const segment of part.data) {
      output.set(segment, cursor);
      cursor += segment.length;
    }
  }
  return output;
}

export function joinGoogleVidsWavsBlob(values: (Uint8Array | ArrayBuffer)[]) {
  const { header, parts, dataPadding } = joinedParts(values);
  const segments: BlobPart[] = [header];
  for (const part of parts)
    segments.push(
      ...part.data.map((bytes) => bytes as Uint8Array<ArrayBuffer>),
    );
  if (dataPadding) segments.push(new Uint8Array(1));
  return new Blob(segments, { type: "audio/wav" });
}

export async function readGoogleVidsWav(
  source: AudioSource,
  signal?: AbortSignal,
) {
  if (source.size > MAX_PART_BYTES) {
    throw invalidWav("Google Vids audio part exceeds 40 MB");
  }
  const reader = source.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (signal?.aborted)
        throw new DOMException("Operation cancelled", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PART_BYTES) {
        throw invalidWav("Google Vids audio part exceeds 40 MB");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  parseWav(bytes);
  return bytes;
}

export function splitGoogleVidsScript(value: unknown) {
  let remaining = String(value || "").trim();
  if (!remaining || remaining.length > TTS_MAX_CHARS) {
    throw new RangeError(`Google Vids accepts 1-${TTS_MAX_CHARS} characters`);
  }
  const chunks = [];
  while (remaining.length > TTS_CHUNK_CHARS) {
    const minimumSentenceBreak = Math.floor(TTS_CHUNK_CHARS * 0.8);
    const minimumWordBreak = Math.floor(TTS_CHUNK_CHARS * 0.7);
    let sentenceBreak = 0;
    let wordBreak = 0;
    for (let index = minimumWordBreak; index <= TTS_CHUNK_CHARS; index += 1) {
      if (!/\s/u.test(remaining[index])) continue;
      if (
        index >= minimumSentenceBreak &&
        /[.!?…。！？]/u.test(remaining[index - 1])
      ) {
        sentenceBreak = index;
      }
      wordBreak = index;
    }
    let cut = sentenceBreak || wordBreak || TTS_CHUNK_CHARS;
    // Do not cut a UTF-16 surrogate pair when a single word exceeds the limit.
    if (
      cut === TTS_CHUNK_CHARS &&
      /[\uD800-\uDBFF]/u.test(remaining[cut - 1])
    ) {
      cut -= 1;
    }
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
