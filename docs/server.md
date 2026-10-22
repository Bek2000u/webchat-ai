# Self-hosted server

Server and Desktop share the API, dashboard and providers. The Docker container
contains Node.js and the built dashboard. A separate **WebChat Server Extension**
executes requests in your Chrome browser, which can run on another computer.
The container does not contain Chrome or website sessions.

## Start with Compose

Requirements: Docker with Compose. Run from the repository root:

```sh
cp .env.example .env
# Set SERVER_TOKEN in .env to a long random value.
docker compose up -d --build
```

In PowerShell, use `Copy-Item .env.example .env`. The Docker build installs only
build dependencies; Electron and browser downloads are disabled. The final image
runs as the unprivileged `node` user.

Open `http://127.0.0.1:8001` on the server. HTTP Basic username is `admin`; the
password is your `SERVER_TOKEN`. Create an API key in the dashboard for clients.

Compose exposes the HTTP port on loopback. For remote access, place an HTTPS
reverse proxy in front of it. The proxy must support WebSockets, preserve the
public `Host` and forward `Authorization`. Set `PUBLIC_ORIGIN` to the external
HTTPS origin so generated file URLs use that address. Do not put credentials or
a `/v1` path in `PUBLIC_ORIGIN`.

## Connect Chrome

1. Download the Server extension ZIP from a release and extract it. Alternatively,
   run `npm ci` and `npm run build:extension:server` from source.
2. Open `chrome://extensions`, enable Developer mode and load the extracted folder
   containing `manifest.json` (source build: `dist/extension-server/chrome-mv3`).
3. In the extension popup, enter the server's HTTPS origin and `SERVER_TOKEN`.
4. Sign in to the provider websites in that Chrome profile. Check connection and
   account access in the dashboard before submitting requests.

The Server extension ID is `opcdjnhnokdpibdhglkjfohgnjokakfp`, the default allowlisted
origin in Compose. It has no automatic localhost connection. Keep Chrome running.
The Desktop extension is a different build and should not be used for this connection.

## Configuration

Copy `.env.example` to a private `.env`; Compose reads it automatically.

| Variable | Meaning |
| --- | --- |
| `SERVER_TOKEN` | Required server administrator/bridge credential |
| `EXTENSION_ORIGINS` | Comma-separated exact `chrome-extension://` origins; defaults to the Server extension in Compose |
| `PORT` | Host loopback port in Compose; default `8001` |
| `PUBLIC_ORIGIN` | Optional canonical HTTP(S) origin, such as `https://webchat.example.com` |

For a direct Node process, also set `WEBCHAT_AI_MODE=server`. `HOST` then defaults
to `0.0.0.0`; `PORT` sets its listen port. `DATA_DIR` defaults to `data`,
`DB_PATH` to `DATA_DIR/app.sqlite3`, and `WEB_DIR` to `dist/web`.
`TEXT_PROVIDER_ORDER` supplies an initial comma-separated text routing order;
saved dashboard settings take precedence.

`SERVER_TOKEN` protects the dashboard, `/api/*` and extension bridge. It is not
the bearer key for `/v1/*`. Inference keys are managed in the dashboard; signed
file URLs and request-scoped extension uploads retain their own authorization.

## API clients

For an OpenAI SDK client, use `https://webchat.example.com/v1` and an API key from
the dashboard. `/v1/models` returns the catalog; execution needs connected Chrome
and access to the requested website capability.

For Bifrost's OpenAI provider integration, configure the upstream origin without
`/v1` if that integration appends `/v1` itself. Check the final path in your client
configuration rather than adding the prefix twice. No Bifrost service is required
to use WebChat AI directly. See [API examples](API.md).

## Run without Docker

```sh
npm ci --ignore-scripts
npm run build:server
npm run build:web
export WEBCHAT_AI_MODE=server
export SERVER_TOKEN='replace-with-your-random-token'
export EXTENSION_ORIGINS='chrome-extension://opcdjnhnokdpibdhglkjfohgnjokakfp'
npm run start:server
```

For PowerShell use `$env:NAME = 'value'` instead of `export NAME='value'`.
A direct Node process does not automatically load the Compose `.env` file.

## Health, updates and backups

These checks do not submit provider generations:

```sh
docker compose ps
curl -f http://127.0.0.1:8001/health/ready
curl -u admin http://127.0.0.1:8001/api/config
```

The last command prompts for `SERVER_TOKEN`. `/health/ready` checks the service
and SQLite, not website access. Check the dashboard for connected profiles.

Compose stores SQLite, settings, file-signing key and generated files in the
`webchat-ai-data` volume (Compose may prefix the volume name with its project name).
Before an upgrade, stop the service and back up that entire volume using your
Docker host's volume backup procedure. Retain ownership/permissions and the signing
key as well as the database and files. Backups contain credentials and request data.

After backing up and updating the source, rebuild with `docker compose up -d --build`.
The volume is retained. Do not run `docker compose down -v` when preserving data.
Update the Server extension separately by replacing the extracted files at the
same path and reloading it in Chrome while no generation is running. Its public
manifest key must remain unchanged to retain its ID and profile storage.
