# Chat2API

Локальное desktop-приложение: API поверх AI-сайтов в обычном Chrome пользователя.
Наше расширение выполняет запросы, Electron даёт окно/tray, а локальный сервер —
один API и один React UI. Сессии сайтов остаются в Chrome.

Без SaaS, admin login, pairing и ручного approve. Внешние клиенты используют
API keys приложения, а не cookies провайдеров.

## Текущее состояние и hardcut

В коде есть шесть провайдеров: ChatGPT, Gemini, Qwen, DeepSeek, Flow и Vids.
Это наличие реализации, не подтверждение live smoke на сайтах. API уже
OpenAI-compatible; внутри сервера LLM используют Vercel AI SDK.

Первый этап hardcut выполнен: собственные HTTP handlers без зависимости от Hebo,
старый `/v1/requests` и обязательный клиент удалены. OpenAI, Vercel и TanStack
compatible проверяются реальными SDK через локальный API с fixture исполнителем.
Целевой список — **12 провайдеров**; шесть новых адаптеров ещё запланированы.
[ARCHITECTURE.md](ARCHITECTURE.md) описывает устройство, [PLAN.md](PLAN.md) — работы.

## Провайдеры

| Провайдер | Назначение | Сейчас |
| --- | --- | --- |
| ChatGPT Web | Текст через UI | Адаптер есть |
| Gemini Web | Текст через UI | Адаптер есть |
| Qwen Web | Текст через UI | Адаптер есть |
| DeepSeek Web | Текст через UI | Адаптер есть |
| Google Flow |  image/video | Адаптер есть |
| Google Vids |  speech | Адаптер есть |
| Google AI Studio | Текст, отдельный provider | Запланирован |
| Z.ai | Текст через UI | Запланирован |
| Kimi | Текст через UI | Запланирован |
| Grok | Текст через UI | Запланирован |
| Meta AI / Muse Spark | Текст через UI | Запланирован |
| Arena | Текст через UI | Запланирован |

LLM используют default/auto сайта без выбора vendor-модели. Общие режимы thinking:
`default`, `fast`, `deep`; фактическая доступность зависит от сайта и аккаунта.
Media сохраняют свои модели и параметры. Новые возможности не считаются
поддержанными только потому, что они перечислены в donor README.

Текстовый `model: "auto"` выбирает включённый online provider в порядке
Gemini → ChatGPT → Qwen → DeepSeek. Порядок задаётся `TEXT_PROVIDER_ORDER`
(например `qwen-web,gemini-web`) или «Настройки → Маршрутизация».
Сохранённый `data/settings.json` имеет приоритет над env; действует без рестарта.
Явный `gemini-web` не переключается на другой
сайт; профили одного provider распределяются по кругу. Thinking не понижается.
Общий observed health хранит последнее назначение, успех и текущий наблюдаемый
сбой. Среди свободных профилей предпочитаем профиль без отказа запрошенной модели,
затем least-recently-assigned. Это in-memory наблюдение, не постоянный account block:
новый ручной запрос допускается и на единственном профиле с прошлой ошибкой.
Ошибка входных данных не ухудшает health. Контракт генерации остаётся прежним:
один запрос provider → один результат либо ошибка; Flow batch не разбивается сервером.

Обычный временный сбой, включая неизвестный результат отправки, допускает одну
свежую попытку. Невалидный/пустой/служебный LLM-ответ — до трёх попыток всего;
transport retry остаётся один. Очередь и попытки используют исходный deadline.
После готового base Flow один раз получает отдельные 5 минут на upscale;
повторный `upscale_ready` не продлевает окно. Async video имеет тот же deadline
даже без polling клиента.
Это новые генерации: возможно повторное расходование квоты, не recovery старого
результата. Ошибка аккаунта направляется на другой профиль, не выключая первый.
Ручной повтор — обычный новый запрос, без блокировки по прошлому коду ошибки.
SDK retries внутри сервера выключены; после его retry budget клиент получает
ошибку, а не скрытый новый цикл. Загрузка готового файла повторяется отдельно.

OpenAI error envelope сохраняет `message/type/code/param` и добавляет
`provider/stage/retryable/outcome/request_id/attempts`. `x-request-id` совпадает
с журналом, где видны выбор профиля, ошибки и решения всех попыток.
Изображения через UI для ChatGPT, Gemini, Qwen и Meta AI/Muse — отдельный будущий
этап; сейчас image/video обслуживает Flow. Его transport и Vids не переписываем.

## Локальный UI

- «Профили Chrome» (`/accounts`): профиль, optional Chrome email, подключение,
  доступные провайдеры и раскрывающаяся общая таблица аккаунтов сайтов.
- «Провайдеры» (`/providers`): сервисы, нагрузка, очередь и профили каждого сервиса.
  Аккаунт сайта не подменяется Chrome email; connection и observed health раздельны.
- «Генератор» (`/generator`): текст, изображения, видео и речь через тот же API,
  реальные параметры моделей, previews, копирование и скачивание. `/playground`
  перенаправляет сюда. Демонстрационные ответы не используются.
- «Статистика» (`/stats`): период 6h/24h/7d, фильтр провайдера, success/errors,
  среднее полное время запроса и ошибки по коду/модели/операции. Это bounded journal,
  не vendor latency: учитываются очередь, повторы и получение результата.
- «Настройки»: порядок текстовых провайдеров для auto, сохраняется без рестарта.

Chrome email — необязательная metadata, не уникальный ключ. Reconnect сохраняет
профиль по UUID. Launcher отдельных Windows Chrome profiles пока не реализован.
Dev storage: `data/app.sqlite3`, таблицы `profiles`, `requests`, `files`, `api_keys`.
Legacy-миграции нет; прежние dev-данные перед hardcut сохранены целиком в
`.tmp/backups/before-app-db-20261015-182642/` (включая проверенный SQLite snapshot).

## Внешние клиенты

Base URL: `http://127.0.0.1:8001/v1`. Авторизация: `Bearer <API key>`.
Специальный Chat2API SDK не требуется:

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';

const chat2api = createOpenAI({
  baseURL: 'http://127.0.0.1:8001/v1',
  apiKey: process.env.CHAT2API_API_KEY!,
});
const result = await generateText({
  model: chat2api.chat('chatgpt-web'),
  prompt: 'Привет!',
  maxRetries: 0,
});
console.log(result.text);
```

Текст, изображения, речь и видео получают тот же набор HTTP-форматов, что в Hebo,
вместо собственного универсального `/v1/requests` envelope.

TanStack подключается к тому же API без нашей обёртки:

```ts
import { chat } from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

const result = await chat({
  adapter: openaiCompatibleText('qwen-web', {
    baseURL: 'http://127.0.0.1:8001/v1', apiKey, maxRetries: 0,
  }),
  messages: [{ role: 'user', content: 'Привет!' }], stream: false,
});
```

Endpoints: `/v1/models`, `/v1/chat/completions`, `/v1/responses`,
`/v1/images/generations`, `/v1/images/edits`, `/v1/audio/speech`, `/v1/videos`
и video status/content. `/v1/audio/voices?model=gemini-3.8-flash-tts&language=ru`
возвращает 30 stock voices с `preview_url`, `preview_language`, характером звучания
(`style`, `style_label`), высотой (`pitch`, `pitch_label`) и `description` из Google Vids.
`preview_languages` перечисляет 23 языка сэмплов. В Playground доступны поиск
по названию, фильтры по характеру и высоте и выбор языка примера. Названия — preset
Gemini (`Schedar`, `Achernar` и т. д.), без алиасов Vids. Это готовые WAV
Google Vids: прослушивание в Playground или внешнем клиенте не запускает TTS.
Без `language` используется `en`; неподдерживаемый язык также использует `en`.
Vids проверяется автоматически при подключении расширения, если его явно не выключили.
Для генерации регистрируются доступными только профили с подтверждённой безлимитной
озвучкой (Paid). Кредитные профили, в том числе с 50 кредитами, и неизвестный тариф
недоступны для Vids; расширение и «Аккаунты» показывают причину. Проверка повторяется
перед генерацией. Статические preview голосов доступны независимо от тарифа.

Речь `gemini-3.8-flash-tts` — WAV, speed 1. Google Vids используется внутри Chat2API;
публичное название модели — `Gemini 3.8 Flash TTS`, владелец — `google`.
Текстовые SSE buffered: завершённый ответ сайта,
не live tokens. Неизвестный token usage возвращается как `null`.
`reasoning_effort`: не задан — default; none/minimal/low — fast;
medium/high/xhigh/max — deep. Неподдерживаемые tools, attachments и sampling
возвращают ошибку до Send. Это не реализация всего OpenAI API.

## Запуск и проверка

Node.js 24+, обычный Chrome. Из корня проекта:

```powershell
npm ci
npm run build
npm start
```

Загрузить `dist/extension/chrome-mv3` через Chrome → Extensions → Load unpacked.
Войти в нужные сайты. API и обе сборки расширения по умолчанию используют
`http://127.0.0.1:8001`.
Закрытие окна скрывает приложение в tray; Quit останавливает API.

Для локальной разработки тот же порт и готовый origin расширения:

```powershell
npm run build:extension:dev
npm run dev
```

Загрузить `dist/extension-dev/chrome-mv3-dev`. `npm run dev:web` запускает Vite
отдельно; `npm run start:server` — собранный API без Electron.

Проверки: `npm run typecheck`, `npm test`, `npm run build`.
Отдельно: `smoke:desktop`, `smoke:extension`, `smoke:crx`; они не заменяют live
генерацию на аккаунтах. `pack:desktop` собирает unpacked app, `dist:win` — installer.

`npm run smoke:live` отправляет реальные запросы через уже запущенный API и
подключённые расширения: четыре LLM, Flow image/video, Vids speech и два `auto`.
Использует аккаунты и квоты сайтов. Отчёт с request IDs, attempts, health и
проверкой media bytes сохраняется в `.tmp/live-smoke-*.json`; временный API key
удаляется после проверки. Для выбора моделей: `SMOKE_MODELS` через запятую.

Один npm-проект: `src/server`, `src/shared`, `src/extension`, `src/web`,
`src/desktop`. `donors/` и `har/` исключены из Git.
Donors — только read-only reference, без переноса их приложения/proxy/token store.
Корневой [LICENSE](LICENSE) содержит MIT; provenance и notices зависимостей
проверяются отдельно перед публичным выпуском.
