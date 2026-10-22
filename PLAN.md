# Roadmap

This describes implemented code and remaining work. An implemented adapter or
passing fixture test is not a guarantee that a website currently works with every
account. See [README.md](README.md) for setup and supported operations.

## Implemented

- [x] One OpenAI-compatible HTTP API for text, images, speech and video.
- [x] Vercel LLM adapters, TanStack media adapters and a shared capability catalog.
- [x] ChatGPT, Gemini, Qwen and DeepSeek text adapters; Flow image/video; Vids speech.
- [x] Shared dispatch, profile selection, request history, API keys and file storage.
- [x] Bounded retries, unknown-submission handling and correlated errors/attempts.
- [x] Dashboard: profiles, providers, generator, requests, statistics and routing settings.
- [x] Optional outbound VideoForge connector using the same API.
- [x] Desktop shell, Windows installer, GitHub updater and managed extension assets.
- [x] Server mode, Docker/Compose, authenticated dashboard and separate Server extension.
- [x] Russian/Uzbek dashboard and Desktop messages; English/Russian/Uzbek extension popup.
- [x] CI definition for checks, extension archives and Windows release artifacts.

## Release acceptance

- [ ] Run the release workflow on GitHub for the version being published.
- [ ] Verify a real installed-app upgrade between two published releases, including
  preservation of data, stable extension identity and the idle reload prompt.
- [ ] Configure and verify Windows code signing for a signed installer.
- [ ] Record current live provider checks separately from fixture/SDK tests.
- [ ] Validate macOS/Linux packaging before offering supported downloads for them.

Local fixture tests and Windows packaging have been exercised. No published-release
upgrade is claimed. Release assets and local verification logs are not source files.

## Planned providers

Google AI Studio, Z.ai, Kimi, Grok, Meta AI / Muse Spark and Arena are planned, not
implemented adapters. Each needs account detection, actual site behavior, supported
thinking modes, errors, fixtures and a separate live check before being advertised.

## Later

- Images through the ChatGPT, Gemini, Qwen and Meta AI website UIs, using the
  existing image API and file storage. Flow remains the current image provider.
- A Windows Chrome profile launcher, without changing profile identity or importing
  website credentials into the server.
