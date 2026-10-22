# Changelog

## 0.2.0

First public release of WebChat AI for Windows and self-hosted servers.

- One OpenAI-compatible API for ChatGPT, Gemini, Qwen and DeepSeek text, Google
  Flow image/video, and Google Vids speech with a voice catalog and static previews.
- Shared dashboard, provider/profile status, API keys, generator and request history.
- Desktop installer with tray integration, GitHub update checks and user-controlled
  download/install. Managed Desktop extension assets retain stable identity.
- Docker/Compose server mode with an authenticated dashboard and a separate Server
  extension that connects through an explicit URL and token.
- Russian/Uzbek dashboard and Desktop messages; English/Russian/Uzbek extension popup.
- Consistent application, installer, extension and web icons. Extension version 1.0.3.
- Public setup, architecture, API, contribution and security documentation.

Windows installers are unsigned. Chrome extensions are installed with Developer
mode / Load unpacked; the browser must stay running. Website behavior and account
access can change. Text SSE is buffered rather than live token streaming.
