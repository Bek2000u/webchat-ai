# Architecture

WebChat AI is one TypeScript/npm application. Desktop and Server share the HTTP
API, dispatcher, storage, provider adapters and React dashboard.

```text
OpenAI / Vercel / TanStack client
        ↓ HTTP
Node API → BrowserDispatcher → Socket.IO → Chrome extension → AI website
   ↑             ↓                              ↓
React UI       SQLite                     browser session

Electron owns the Desktop window, tray, local API lifecycle and updater.
Docker runs the same API and UI without Electron or a browser.
```

## Code ownership

| Path | Responsibility |
| --- | --- |
| `src/server/` | HTTP, SDK adapters, routing/dispatch, SQLite, API keys, files |
| `src/shared/` | Serializable commands, results, errors and model capabilities |
| `src/extension/runtime/` | Connection, profiles, tabs, account checks, cancellation, media transfer |
| `src/extension/playwright/` | Chrome debugger transport and DOM automation |
| `src/extension/providers/` | Website-specific behavior and media operations |
| `src/web/` | Shared React dashboard, generator and management client |
| `src/desktop/` | Electron shell, API process, updates and managed extension files |
| `tests/`, `scripts/` | Tests, smoke fixtures and build tools |

`src/shared/models.ts` is the capability catalog used by the API, dashboard and
extension. LLM adapters use Vercel `LanguageModelV4`; media adapters use TanStack
interfaces. The extension receives serializable commands, not server SDK instances.
Public HTTP formats are independent of those internal SDK interfaces.

## Modes and authentication

- **Desktop** binds to loopback and serves a local dashboard without a login.
  The API checks local browser origins; the extension uses an exact allowlisted
  origin and its profile credential. External API clients use bearer API keys.
- **Server** accepts a configured listen address. Its dashboard and management
  API require HTTP Basic `admin/SERVER_TOKEN`; the separate Server extension sends
  that token in Socket.IO authentication in addition to its profile credential.
  Inference clients still use their own API keys. Remote deployments need HTTPS.

Desktop and Server extension public keys produce distinct, stable IDs. The public
keys are identity metadata, not credentials. Server mode has no automatic localhost
connection. Neither mode launches or embeds a user's Chrome browser.

## Request lifecycle

The HTTP handlers validate supported fields and convert a request to a shared
browser command. The existing `BrowserDispatcher` selects a free provider/profile
slot, persists the request and dispatches it to Chrome. The extension verifies
website access, executes the operation, and uploads the result through the API.

An explicit text model stays on its provider. `auto` follows the configured text
provider order. Saved settings take precedence over environment defaults.
Observed health is held in memory and influences profile preference; it does not
permanently block an account. Input errors do not lower provider health.

Preparation errors known to occur before submission allow one fresh retry.
An unknown submission outcome, timeout or lost browser connection does not trigger
a new generation. Invalid completed LLM output permits at most three attempts in
total, with a separate bounded transport retry. Attempts retain the original
deadline and use distinct operation identities to reject late results.

Flow can receive one additional five-minute upscale window after its base result
is confirmed ready. Repeated or stale upscale notifications do not extend it.
Video status/content reads retrieve the original request and do not resubmit it.
Artifact download failures retry the same artifact rather than generating again.
Cancelling a local wait does not prove cancellation at the website.

The API returns an OpenAI error envelope with `x-request-id` correlation and
additional provider, stage, outcome and attempt information. Text SSE is buffered
delivery of the completed website response. Token usage is not invented.

## Provider execution

Text providers use a shared Chrome debugger/Playwright DOM runtime. Site adapters
own selectors, account/tier checks, thinking controls and completion/error detection.
Each API call starts a new website conversation using the supplied messages.

Flow image/video and Vids speech use their existing native browser transports.
Flow batch execution stays within one provider operation. Vids collects ordered
audio chunks and validates the final WAV. Voice previews are static public samples
and are separate from speech generation.

The Playwright injected DOM engine is generated from the pinned installed
`playwright-core` dependency. It is not a second browser process or provider runtime.

## Storage

`node:sqlite` owns `app.sqlite3`, with WAL and a five-second busy timeout.
It stores profiles, API key hashes, request/attempt history, file metadata and
optional connector request claims. Files live under the current data root and
are addressed by file ID. Signed file URLs use a persistent per-installation key.

Website sessions live in Chrome. The server stores its own profile credentials
and optional connector token; local configuration files are not encrypted.
Chrome email is optional display metadata; profile UUID is the identity.
Moving or upgrading must preserve the database, file directory, signing key and
extension identity. Runtime data and research captures are excluded from Git.

## Desktop updates and extension delivery

`electron-updater` checks the configured GitHub Releases feed after a packaged
startup. Download and installation require explicit user actions. Development and
smoke runs disable updater networking.

The shell copies the bundled extension to `<userData>/extension`, verifies its
manifest key, and retains the previous assets. The popup offers an explicit reload
only while idle. Chrome does not silently update an unpacked extension. Server
extension ZIPs are installed and updated separately. See [release instructions](docs/DESKTOP-RELEASE.md).

## Optional VideoForge connector

`src/server/videoforge-connector.ts` opens an outbound WebSocket when enabled by
the user. It forwards allowlisted `/v1` operations through the same API/dispatcher.
Management routes, arbitrary destinations and website cookies are not exposed.

SQLite stores a claim before dispatch. Repeated POST requests with the same
origin/connection/request identity reuse the result; an unfinished claim after a
restart returns `outcome_unknown`. Reconnection does not resubmit a generation.
GET status remains fresh. Media responses stream chunks with cancellation and
backpressure; ordinary response bodies are buffered.

Implementation status and future providers are tracked separately in [PLAN.md](PLAN.md).
