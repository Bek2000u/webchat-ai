# Desktop installer and updates

Desktop owns its existing Electron shell and starts the same local API on
`127.0.0.1:8001`. Provider sessions remain in the user's Chrome profile.
No Chrome process is launched by the installer or updater.

## Build and release

```powershell
npm ci
npm run dist:win
```

The Windows NSIS installer is produced in `release/`. Local builds use
`--publish never`. The configured update feed is `Bek2000u/webchat-ai` and expects
publicly accessible GitHub Releases. The Desktop app does not embed a GitHub token.
This setup does not change repository visibility or sign installers automatically.

The [release workflow](../.github/workflows/ci.yml) runs checks on pushes/PRs.
Manual workflow dispatch also builds the Windows installer without publishing.
Pushing a version tag publishes a release after the Linux and Windows jobs pass;
the tag must be `v` followed by the version in `package.json`.

Every release includes these assets together:

- `WebChat-AI-<version>-x64.exe` and its `.blockmap`.
- `latest.yml`, matching that installer.
- `webchat-extension-v<version>.zip` (Desktop).
- `webchat-server-extension-v<version>.zip` (Server).
- `SHA256SUMS.txt` for the installer, updater metadata and extension archives.

Before tagging, check app/extension versions, authentication and data compatibility,
license files, installer signature status and the changelog/release notes. Do not
attach local databases, captures or verification directories to a release.

`electron-updater` reads the bundled `app-update.yml` written by
electron-builder. The application performs one metadata check 15 seconds after
a packaged launch. Checking again, downloading and installing are separate user
actions in Settings and the update popup. Downloaded updates are not installed
automatically on exit. The unpackaged development app and Desktop smoke disable
update networking.

macOS automatic updates require a signed application, and its release must
include a ZIP alongside the DMG. Linux users need a supported packaged target,
such as AppImage. A directory build is useful for smoke verification, but is not
an installed update test. These are native
[electron-builder update requirements](https://www.electron.build/v26/docs/features/auto-update/).

## Chrome extension

The application copies its bundled Desktop extension to the stable writable
`<userData>/extension` directory. Open **Settings → Chrome extension → Folder**,
then load that directory once through `chrome://extensions` with Developer mode
and **Load unpacked**. Existing installations loaded from an old resources path
should select this stable directory. The unchanged manifest key preserves the
extension ID; browser storage and site sessions are not copied into Desktop.

On an application update, the shell replaces only the managed extension assets
at this same path and retains the previous bundle at
`<userData>/extension.previous`. The source manifest key is checked before
replacement. The app's SQLite database and Chrome profile are untouched.

The extension popup compares its running version with `/health.extensionVersion`
from the Desktop API. When an update is available, **Reload extension** explicitly
reloads it after checking that no generation is active. Chrome does not silently
update a consumer's unpacked extension through `update_url`. This mechanism uses
the files delivered with the application release instead.

Increase the extension manifest version whenever extension code changes. It is
versioned independently from the application: Desktop `0.2.0` currently bundles
extension `1.0.3`. A release must not reduce either version. The Server extension
is a separate build and must not replace the Desktop extension folder.

## Local verification

```powershell
node --import tsx --test tests/desktop/*.test.ts
npm run build
npm run smoke:desktop
npm run pack:desktop
```

Desktop test fixtures and screenshots stay in `tmp/desktop-updates/` inside this
checkout. Unit tests use a fake updater and exercise manual download/install,
coalescing, unavailable releases, failures, disabled development networking,
stable extension assets and RU/UZ preferences. The smoke uses an isolated local
API and a synthetic provider bridge; it does not send provider requests or
install a release. A real installed-app upgrade remains a separate acceptance
check after two releases have been published.

Native tray and startup messages use RU/UZ, defaulting to the OS language
(`uz` or Russian fallback). The UI language selection persists under the existing
application data directory in `desktop-preferences.json`.

## Icons

`resources/icon.svg` is the source artwork for the application, NSIS installer,
tray, Chrome extensions, dashboard and browser favicons. Generated PNG/ICO assets
are committed, so normal builds do not need a browser for icon conversion.
After changing the SVG, set `PLAYWRIGHT_BROWSERS_PATH` to your installed test-browser
directory inside the checkout and run `npm run build:icons`. Rebuild both extensions
and the installer afterward. The Windows ICO contains sizes 16 through 256 pixels;
the application PNG is 512 pixels and the Apple touch icon is 180 pixels.
