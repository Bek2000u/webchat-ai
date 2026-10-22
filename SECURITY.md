# Security

## Reporting a vulnerability

Use **Security → Report a vulnerability** on the GitHub repository when private
reporting is available. If it is unavailable, open an issue asking for a private
contact without including exploit details, credentials or affected private data.
Do not post a live token or account/session capture in a public issue.

Include the affected app/extension version or commit, Desktop/Server mode,
reproduction steps, expected impact and a sanitized proof of concept.

## Deployment and local data

- Desktop is intended for loopback access. Use Server mode with HTTPS for remote
  access; do not expose the unauthenticated Desktop dashboard to a network.
- Server's `SERVER_TOKEN` authenticates the administrator and extension bridge.
  External inference clients use separate API keys. Share these credentials only
  with trusted clients and connected browsers.
- Preserve the exact extension-origin allowlist. Public extension manifest keys
  are identity metadata and are intentionally included in source.
- Request history, generated files, profile credentials, the file-signing key and
  optional connector token are local sensitive data. Configuration files are not
  encrypted. Keep the data directory and backups private.
- Website sessions remain in Chrome. The extension has website/debugger permissions
  needed for automation; install and connect it only in profiles you control.
- Signed media URLs grant access to the referenced file. Treat them as private
  while valid, including in logs and screenshots.

`.gitignore` and `.dockerignore` exclude common local data and credentials, but
they cannot remove a secret from an already published commit. If a credential is
exposed, revoke or rotate it before cleaning the repository history.

See [Server setup](docs/server.md) for authentication, proxy configuration and
persistent storage, and [Desktop updates](docs/DESKTOP-RELEASE.md) for release behavior.
