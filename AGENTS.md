# WebChat AI agent contract

## Язык и стиль

- На русский и транслит отвечать нормальной русской кириллицей.
- Сначала проверять реальное состояние репозитория, CI и production, затем менять.
- Давать короткий итог: что изменено, абсолютные пути и чем проверено.

## Источники решений

- README.md — текущее состояние и запуск; ARCHITECTURE.md — устройство приложения;
  PLAN.md — roadmap. План не выдавать за готовую реализацию.
- donors/ — read-only reference; не переносить их приложение/proxy/token store.
- Внешний контракт — OpenAI-compatible; LLM — Vercel, media — TanStack.
- WebChat AI — самостоятельное приложение с одним API, dispatcher и registry.
