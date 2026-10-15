# Chat2API agent contract

## Язык и стиль

- На русский и транслит отвечать нормальной русской кириллицей.
- Сначала проверять реальное состояние репозитория, CI и production, затем менять.
- Давать короткий итог: что изменено, абсолютные пути и чем проверено.

## Источники решений

- README.md — текущее состояние; ARCHITECTURE.md — единая архитектура;
  PLAN.md — этапы hardcut. План не выдавать за готовую реализацию.
- donors/ — read-only reference; не переносить их приложение/proxy/token store.
- Внешний контракт — OpenAI-compatible как в Hebo; LLM — Vercel, media — TanStack.
- Chat2API самостоятельный: Hebo только reference, без его dependency/imports.
