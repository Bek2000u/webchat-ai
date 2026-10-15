# Архитектура WebChat AI

Единое целевое устройство. Что уже есть и что предстоит — в [PLAN.md](PLAN.md).
Первый API hardcut реализован; новые провайдеры и UI image adapters ещё в плане.

## 1. Local-first

```text
OpenAI SDK / Vercel AI SDK / HTTP
  → локальный API → BrowserDispatcher → Chrome extension → сайт
  ← стандартный результат либо ошибка ←────────────────────┘

React UI → тот же API
Electron → окно/tray и жизненный цикл API
```

Сервер по умолчанию loopback-only. Локальный UI без admin; extension без
pairing/approve. Проверка extension origin и credential зарегистрированного
профиля остаётся. Cookies и website login не покидают Chrome.
Удалённый доступ/Tailscale не является обязательным слоем приложения и требует
отдельной настройки: текущий сервер не слушает сетевой интерфейс.

## 2. Внешний контракт — как в Hebo Gateway

Основа — существующие `src/providers/types.ts`, `docs/PROVIDER_SDK_POLICY.md`,
`docs/MEDIA_HTTP_API.md` и endpoint-схемы `forge/hebo-gateway` (`@hebo-ai/gateway`).
Берём единый контракт, а не запускаем ещё один gateway/proxy перед WebChat AI.

| Операция | Целевой endpoint и формат |
| --- | --- |
| Каталог | `GET /v1/models` → OpenAI `list/data` |
| Текст | `POST /v1/chat/completions` → JSON/SSE |
| Текст через Responses | `POST /v1/responses` → JSON/SSE |
| Изображения | `POST /v1/images/generations`, `/v1/images/edits` → `created/data` |
| Речь | `POST /v1/audio/speech` → audio bytes; SSE metadata |
| Видео | `POST /v1/videos`, `GET /v1/videos/:id`, `/v1/videos/:id/content` |

Авторизация: `Authorization: Bearer ...`. Ошибка:
`{ error: { message, type, code, param } }`, корреляция через `x-request-id`.
Media options/artifacts сохраняются в `provider_options` / `provider_metadata`.
Публичная speech-модель — `gemini-3.8-flash-tts` / `Gemini 3.8 Flash TTS`,
`owned_by: "google"`. Google Vids — внутренний browser provider WebChat AI:
его routing ID остаётся в локальном `/api/models`, а `providerId` не выводится
в публичном `/v1/models` и карточке `/v1/models/:id`.
Каталог голосов — `/v1/audio/voices?model=gemini-3.8-flash-tts&language=ru`.
Для каждого голоса возвращаются `voiceId`, `name`, `origin`, `style`, `style_label`,
`pitch`, `pitch_label`, `description`, `preview_url` и `preview_language`.
Каноническое название — preset Gemini (`Schedar`, `Achernar` и т. д.): `name`
совпадает с `voiceId`. UI показывает название один раз, без алиасов Google Vids.
Характер звучания и высота взяты из карточек Google Vids; `style` и `pitch` —
стабильные коды для фильтрации, поля `*_label` и `description` — подписи на русском.
Высота: `high`, `medium`, `medium-low`, `low`. Отдельное поле пола в этих карточках
отсутствует, каталог его не выводит. `preview_languages` содержит 23 языка сэмплов.
Preview — готовые публичные WAV Google Vids на
`ssl.gstatic.com/docs/videos/audio/voice_samples/gemini-v4s-tts/1.1/{language}/{voice}.wav`.
Язык по умолчанию — `en`; региональные коды нормализуются, неподдерживаемые
языки используют английский пример, как в редакторе Vids. Playground фильтрует
каталог по названию, характеру и высоте, позволяет выбрать язык примера и проигрывает
выбранный пример по нажатию; Chrome, аккаунт Google и генерация речи для preview
не требуются. Внешние клиенты используют `preview_url` напрямую.

Это совместимость перечисленных операций, не всего OpenAI API. Дополнительные
протоколы, embeddings и новые возможности не входят в текущий hardcut.
Неподдерживаемые tools/attachments/режимы не игнорируются молча и не объявляются
доступными без реализации. Vendor-specific ограничения остаются видимыми.

Старый публичный `/v1/requests` удаляется при переходе. Внутренний `/api/*`
остаётся для профилей, ключей, истории и настроек, не для второго generation API.
Playground использует тот же generation API, что внешние клиенты.

WebChat AI самостоятельный: собственные handlers и runtime validation в `src/server`.
Hebo — только reference форматов, без dependency/imports, копирования его кода
и дополнительного HTTP hop. Публичные типы SDK импортируются из стандартных
пакетов; browser/UI DTO остаются своими. Сам Hebo здесь не меняется.

## 3. SDK и shared contracts

Как в Hebo: LLM — Vercel `LanguageModelV4`; image/speech/video — TanStack
interfaces. Текущая линия — AI SDK 7 / provider v4; она не привязана к версии Hebo.
Внутренний SDK не определяет внешний HTTP-формат: TanStack media также выходят
через OpenAI-compatible endpoints.

SDK-адаптер на стороне API переводит вызов в serializable browser command.
В extension остаются browser runtime и операции сайтов без отдельного LLM SDK.
Функции, SDK instances и server-only imports в Chrome не передаются.

`src/shared/contracts.ts` — только собственные UI DTO, browser commands/results
и ошибки. Стандартные SDK/HTTP-типы импортируются из их владельцев, не копируются.
`src/shared/models.ts` — один источник model/capability definitions; API, UI и
extension используют его проекции, а не разные каталоги.

Для внешнего клиента достаточно OpenAI SDK или Vercel compatible provider.
TanStack использует готовый `@tanstack/ai-openai/compatible` на том же API.
Собственного `src/client` и обёрток над `/v1/requests` больше нет.

## 4. Общий runtime и site adapter

Общее: вкладки, CRX attach/detach, ожидания, timeout/abort, account verification,
новый чат, полный ввод prompt, один Send, completed result и нормализация ошибок.
Сайт отвечает за origin, identity/tier, selectors, temporary chat, thinking
controls, признаки завершения и конкретные provider errors.

LLM отправляются через UI на общем CRX/Playwright runtime. Конкретную vendor-модель
не выбираем: default/auto сайта. Сообщения текущего клиентского запроса собираются
в prompt нового чата; скрытой серверной истории нет. Temporary chat включается
там, где подтверждена поддержка.

CRX attach включает стандартный Playwright `Emulation.setFocusEmulationEnabled`:
сайт получает active/visible состояние без переключения настоящей активной вкладки.
Detach снимает override. Баннер Chrome debugger относится к transport, не означает
остановку JavaScript. Gemini new_chat один раз навигирует на `/app` до Send;
при ожидании ответа страницу не перезагружаем и повторный Send не делаем.

Внутренние thinking-режимы: `default`, `fast`, `deep`. Стандартные reasoning-поля
OpenAI переводятся в них на одной границе. `default` не навязывает настройку;
`fast`/`deep` проверяют фактическое переключение до Send, иначе понятная ошибка.
Paid/free определяется по аккаунту; недостоверные данные дают unknown.

Vids по умолчанию проверяется при регистрации (явное выключение сохраняется).
Его native voiceover quota `unlimited` регистрируется как Paid/available;
`credit` — Free/unavailable, неизвестный доступ — unavailable. Это проверка доступа
к озвучке Vids, не тарифа Gemini/Flow того же Google-аккаунта. Extension передаёт
tier и причину отказа, сервер не принимает Vids available без подтверждённого Paid.
Перед генерацией адаптер заново проверяет аккаунт и доступ.

Flow image/video и Vids speech сохраняют native transport, без перевода Generate
на UI clicks. Flow batch остаётся внутри одного вызова; Vids chunking — внутри
speech-операции с итоговым аудио. Новые лимиты подтверждаются реальным сайтом/HAR.

Будущий этап: image через UI у ChatGPT, Gemini, Qwen и Meta AI/Muse.
Используем тот же CRX runtime, общий image результат и существующий upload/storage.
В site adapter остаются выбор image-tool, selectors, завершение и получение файла.
Наружу — тот же image API, не новый transport. Этот этап пока не реализован;
он не переводит Flow/Vids на UI clicks.

## 5. Исполнение и ошибки

Один логический request → ограниченные свежие attempts → результат или ошибка. Существующий
BrowserDispatcher выбирает свободный provider/profile slot; разные slots могут
работать параллельно. Второй router/queue/workflow engine не нужен.

SQLite хранит профили, ключи, историю и файлы. Video status/content возвращают
исходный request/result, не повторяют генерацию. Restart Chrome не восстанавливает
старую browser job. Неизвестный исход не восстанавливает старый результат:
общая retry policy может создать одну свежую генерацию, явно учитывая её в attempts.

Extension нормализует provider/stage/code/message/retryability и исход отправки.
API преобразует ошибку в OpenAI envelope, UI показывает те же факты.
Service message, couldn't-load response, пустой/оборванный результат — не success.
Account block отличается от временной ошибки страницы/transport; ошибка одного
запроса не должна бессрочно выключать рабочий аккаунт.

Повторы подготовки ограничены и возможны до Send. Обычный transient/unknown —
до двух attempts; невалидный LLM-result — до трёх всего, transport retry только один.
Все attempts укладываются в исходный model deadline; смена профиля его не обновляет.
Исключение Flow: только после подтверждённого ready base driver отправляет
`upscale_ready` с номером attempt и ждёт ACK. API один раз переключает deadline на
5 минут upscale; повторное событие, старый claim и expired/cancelled request его
не продлевают. Это работает и при async video без HTTP wait/polling.
Включённые profiles одного provider выбираются round-robin; `auto` проходит
`TEXT_PROVIDER_ORDER`, явная модель не меняет provider. Mode сохраняется при fallback.
Общее observed health для всех providers хранится только в памяти dispatcher:
lastAssignedAt, lastSuccess и lastError с model/code/message/time. Среди свободных
профилей сначала выбираются не имеющие наблюдаемого отказа нужной модели, затем
least-recently-assigned. Ошибки input не ухудшают health. Успех снимает наблюдаемый
отказ этой модели, смена аккаунта сбрасывает наблюдения provider. Это предпочтение
маршрутизации, не blacklist: единственный профиль остаётся доступен для нового вызова.
Flow batch остаётся одним provider call с одним result/error. Partial batch,
серверные группы 1–4 и per-image jobs не добавляются.
Account rejection не повторяется на том же профиле и не создаёт постоянный block.
Ручной новый запрос доступен независимо от прошлой ошибки. У свежей attempt новая
provider operation identity, поздний result/cancel старой не завершает новую.
SDK retries не создают вложенную
повторную отправку. Abort локального ожидания не доказывает отмену на сайте.
Обычная ошибка получает корректный HTTP status; после начала SSE — ошибку протокола.
OpenAI envelope содержит также provider/stage/retryable/outcome/request_id/attempts;
message ограничен понятным summary без raw HTML/JSON/stack, ID совпадает с header.
История attempts хранится в существующем request journal. Dev hardcut использует
новую `app.sqlite3` с таблицами `profiles`, `requests`, `files`, `api_keys`;
legacy-миграции нет. До смены данных сохраняется SQLite snapshot и вся data.
Отдельного workflow/attempt store нет.
Готовый original artifact скачивается не более двух раз; download/upload failure
не вызывает новую генерацию. Пустые файлы и HTML/JSON ошибки не выдаются за media.
Vids проверяет WAV каждой сцены, сохраняет порядок и собирает один итоговый WAV;
ошибка чтения повторяет тот же audio URL, не Generate all scenes.

SSE не обещает live tokens: completed DOM-result выдаётся после завершения как
buffered delivery. Нет искусственного потока по таймеру и выдуманного token usage.

## 6. Владельцы кода и UI

Один TypeScript/npm-проект, без восстановления прежнего монорепо:

| Путь | Ответственность |
| --- | --- |
| `src/server/` | HTTP, SDK adapters, dispatch, SQLite, files, API keys |
| `src/shared/` | Serializable browser/UI contracts, единый capability catalog |
| `src/extension/runtime/` | Общие tabs/session/account/abort/media transfer/errors |
| `src/extension/playwright/` | Узкий CRX transport и DOM automation |
| `src/extension/providers/` | Только специфичный код сайтов |
| `src/web/` | Один React/shadcn renderer и UI API client |
| `src/desktop/` | Electron shell/tray, запуск/остановка API |
| `tests/`, `scripts/` | Проверки и сборка |

Новые packages/apps или второй registry/store без конкретной необходимости не нужны.
Один UI для desktop/browser: dashboard, Chrome profiles/providers, generator, stats, requests,
API keys, settings. Chrome profile — контейнер его providers с identity/tier/status/load.
Chrome identity в hello — optional metadata, отдельная от provider accountSubject.
Email не уникален и не заменяет UUID; повторный hello обновляет существующий профиль.
Таблицы профилей и провайдеров раскрывают один общий список provider/profile slots.
Connection/access отделён от observed health; pending queue агрегируется на сервере
один раз по provider, auto отдельно. Настройки text routing — только порядок моделей
для auto: settings.json → env → defaults, без второго router или новых стратегий.
SQLite: app.sqlite3; profiles/requests/files/api_keys. По решению владельца dev
переходит на свежую схему после backup, без импорта legacy DB и миграций.
Windows launcher остаётся отдельным будущим этапом.
Общие прежние design tokens сохраняем; extension UI использует те же токены,
а не отдельный design system. Admin/approve/vendor token management не возвращаем.

## 7. Donors — только reference

| Donor | Что изучаем |
| --- | --- |
| Chat2API | Shell/tray, navigation, dashboard, keys, requests, settings |
| WebAI2API | Browser behavior, Arena, completed result и provider errors |
| AIStudioToAPI | Google AI Studio: session, UI flow, запросы и ограничения |
| MetaAI-Free-Hermes-Agent | Meta AI / Muse Spark: browser flow и ответы |

`donors/` и `har/` исключены из Git. Donors не изменяем и не включаем в runtime.
Не переносим их proxy/token store, Camoufox/VNC, Go backend или agent framework.
Идеи проверяем на сайте. Перенос исходного кода потребовал бы отдельной license
проверки; этот план предполагает reference, не копирование.
