# Contributing

Read [README.md](README.md) for setup and [ARCHITECTURE.md](ARCHITECTURE.md) for code
ownership. [PLAN.md](PLAN.md) separates implemented features from planned providers.

## Local setup

Use Node.js 24+ and the committed npm lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Use the existing repository dependencies. Keep temporary projects, test data,
screenshots and build caches under `tmp/<task>/` in the checkout; do not use personal
browser profiles for fixtures. Do not commit `node_modules`, runtime data or output.
The `private` package flag prevents accidental npm publication; it does not control
the GitHub repository's visibility or the MIT source license.

## Changes and validation

Keep changes focused and use the existing API, dispatcher, capability catalog and
provider runtime. A new website adapter belongs in `src/extension/providers/` and
must declare only capabilities it actually implements. Preserve extension public
keys/IDs and existing profile/data compatibility.

Run checks relevant to the change. For a complete integration change, the commands
above are the baseline. Include what was tested in the pull request and distinguish:

- Unit/HTTP/SDK tests with fixtures (`npm test`).
- Browser/Electron fixtures (`npm run smoke:desktop`, `smoke:extension`, `smoke:crx`),
  which require a matching installed test browser and built assets.
- Installer packaging (`npm run dist:win`) and a real installed-app upgrade.
- Live website generation (`npm run smoke:live`), which uses real connected accounts
  and can consume their credits/quotas. Run it only deliberately; it is not a default
  prerequisite for documentation changes.

Set `PLAYWRIGHT_BROWSERS_PATH` to a directory inside the checkout before installing
a Playwright test browser. Use the locally installed Playwright executable. Keep
test-browser downloads and fixture profiles separate from personal Chrome data.
For smoke scripts using the OS temporary directory, set `TEMP`, `TMP` and `TMPDIR`
to an existing directory under `tmp/` before running them.

Local builds do not publish. Version-tag pushes trigger the release workflow;
prepare them deliberately using [Desktop release instructions](docs/DESKTOP-RELEASE.md).
The app and extension have separate versions. Raise the extension manifest version
for extension changes and retain the public key so installed identity stays stable.

## Issues and pull requests

Use [GitHub Issues](https://github.com/Bek2000u/webchat-ai/issues) for reproducible
bugs and feature requests. Include the app/extension versions, operating system,
mode, provider, steps and sanitized request/error details. For browser issues,
identify whether it fails with fixtures or a real website session.

Never attach cookies, bearer keys, connector tokens, `.env`, databases, browser
profiles or raw HAR captures. Use synthetic identities such as `user@example.com`
in fixtures. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

Retain existing copyright and license information. Do not copy third-party source
without checking its license and preserving required notices. Dependencies keep
their own licenses; the project's source is [MIT](LICENSE).
