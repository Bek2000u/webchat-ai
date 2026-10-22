# API and clients

Base URL: `http://127.0.0.1:8001/v1` for Desktop, or your server's HTTPS origin plus
`/v1`. Create a key in **API keys** and send `Authorization: Bearer <API key>`.
The Server administrator token is a separate credential.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/models` | OpenAI-style model list |
| GET | `/v1/models/:id` | Model metadata |
| POST | `/v1/chat/completions` | Chat JSON or buffered SSE |
| POST | `/v1/responses` | Responses JSON or buffered SSE |
| POST | `/v1/images/generations` | Image generation result |
| POST | `/v1/images/edits` | Image editing result |
| POST | `/v1/audio/speech` | Generated audio |
| GET | `/v1/audio/voices` | Voice metadata and static preview URLs |
| POST | `/v1/videos` | Video request |
| GET | `/v1/videos/:id` | Status of the original video request |
| GET | `/v1/videos/:id/content` | Completed video content |
| GET | `/v1/files/:id` | Stored media through its signed URL |

This is compatibility for the listed operations, not the entire OpenAI API.
Capabilities and accepted media options come from `src/shared/models.ts` and the
server validators. Unsupported tools, attachments or sampling options return
errors. Embeddings and transcription are not implemented.

## Text with Vercel AI SDK

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const provider = createOpenAI({
  baseURL: 'http://127.0.0.1:8001/v1',
  apiKey: process.env.WEBCHAT_AI_API_KEY,
});

const result = await generateText({
  model: provider.chat('qwen-web'),
  prompt: 'Hello!',
  maxRetries: 0,
});
console.log(result.text);
```

Text IDs are `chatgpt-web`, `gemini-web`, `qwen-web`, `deepseek-web` and `auto`.
Each explicit ID uses that site's default/auto model. `auto` follows the provider
order in Settings, initially Gemini → ChatGPT → Qwen → DeepSeek. Saved settings
take precedence over `TEXT_PROVIDER_ORDER`.

Thinking maps to the website's `default`, `fast` or `deep` modes. An omitted
`reasoning_effort` keeps the default; `none/minimal/low` map to fast and
`medium/high/xhigh/max` to deep. Switching must be supported by the account/site.

SSE delivers a completed website response rather than live model tokens. Unknown
token usage is `null`. Disable client SDK retries if you want retry decisions to
remain within the server's bounded policy.

## TanStack compatible client

```ts
import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

const result = await chat({
  adapter: openaiCompatibleText('qwen-web', {
    baseURL: 'http://127.0.0.1:8001/v1',
    apiKey: process.env.WEBCHAT_AI_API_KEY,
    maxRetries: 0,
  }),
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: false,
});
```

Examples that generate content consume the connected website account's quotas.
`GET /v1/models` can be used for a connection check without generating content.

## Media and voices

Flow handles image/video operations. Inspect the catalog for supported model IDs,
sizes, durations, references and other options instead of assuming another
provider's parameters work unchanged.

Vids speech uses `gemini-3.8-flash-tts` and produces WAV at speed 1. It requires
confirmed unlimited voiceover access; credit-based or unknown access is unavailable.

`GET /v1/audio/voices?model=gemini-3.8-flash-tts&language=ru` returns voice IDs,
names, style/pitch metadata, descriptions and `preview_url`/`preview_language`.
`preview_languages` lists sample languages. The default and unsupported-language
fallback is English. Previews are existing public WAV samples and do not submit
speech generation. API authentication is still required for the catalog route.

## Errors and request identity

Errors use `{ error: { message, type, code, param, ... } }`. Additional fields
include provider, stage, retryability, submission outcome, request ID and attempts.
`x-request-id` correlates the response with the request journal.

An unknown submission outcome is not an invitation to resubmit automatically.
Status/content reads do not generate content. A deliberate new generation is a
new request and may consume another quota or credit charge.

## VideoForge connector

The optional connector opens an outbound WebSocket from WebChat AI to a configured
VideoForge instance. In Settings, enter the instance's HTTPS origin and connector
token, then connect. No public incoming Desktop port is needed. For development,
HTTP is accepted on loopback.

The connector forwards allowlisted generation/catalog/status/content requests
through the same `/v1` API and dispatcher. It does not expose management routes or
website cookies. The token is stored in `data/videoforge-connector.json`; the UI
receives only its saved status. That file is a local secret, not an encrypted vault.

Request claims in SQLite prevent reconnection or repeated transport POSTs from
blindly resubmitting content. An unfinished claim after restart returns
`outcome_unknown`. Ordinary bodies are limited to 64 MiB; streamed media GETs use
chunks up to 1 MiB with a 512 MiB media ceiling.
