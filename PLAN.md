# План hardcut WebChat AI

Основа: [ARCHITECTURE.md](ARCHITECTURE.md). Это план, не отчёт о готовых интеграциях.
Без SaaS, admin/pairing, второго сервера и recovery Chrome jobs. Donors — read-only.

## Исходное состояние

Один npm-проект. В коде шесть providers; live smoke в этой работе не выполнялся.
Первый API hardcut реализован: собственный OpenAI-compatible API, Vercel LLM,
без Hebo dependency. Шесть новых адаптеров отсутствуют.
При проверке в этой папке нет `.git`: перед будущим commit установить происхождение
checkout, не делать `git init` и не выдавать копию файлов за сохранённую историю.

## 1. API hardcut

- [x] Убрать Hebo dependency/imports; собственные HTTP handlers по совместимому
  контракту, без второго gateway service и копирования донорского кода.
- [x] LLM server adapter → Vercel `LanguageModelV4`;
  extension → serializable commands и site operations без LLM SDK.
- [x] Оставить TanStack media и native Flow/Vids transport.
- [x] `/v1/models`, `/v1/chat/completions`, `/v1/responses`: JSON/SSE,
  API keys, единые errors/request IDs и reasoning → default/fast/deep.
- [x] Image generations/edits, speech, video create/status/content;
  сохранить provider options/artifacts и существующие voices.
- [x] Перевести playground на общий generation API, удалить публичный
  `/v1/requests` и старые обязательные клиентские обёртки.
  UI `/api/*` оставить для управления приложением.

Приёмка: настоящие OpenAI SDK и Vercel `generateText`/`streamText` проходят HTTP
contract tests с fixture browser executor; TanStack compatible проверяет оба text
endpoint. Media проверяются через OpenAI и Vercel SDK по тому же HTTP-контракту.
Это ещё не live provider smoke.

## 2. Unify runtime и UI

- [x] Один BrowserDispatcher/store/file store; routing в существующем dispatcher.
  Явный provider + round-robin profiles; `auto` и `TEXT_PROVIDER_ORDER` для текста.
- [x] Общие in-memory observations для всех providers: lastAssigned/lastSuccess/
  lastError, предпочтение здоровой модели и least-recently-assigned без cooldown/
  permanent block. Контракт generation сохранён; partial batch отменён владельцем.
- [ ] Общие tabs/session/account/abort/waits в существующем runtime;
  selectors/thinking/temporary/result остаются в конкретном site adapter.
- [ ] Один browser/UI contract и capability catalog; SDK DTO не копировать.
- [x] Одна нормализация errors extension → API → UI. Service/error text не success,
  HTTP status корректный; account tier/usage не выдумываются.
- [x] Bounded preparation retries до Send; общая fresh-attempt policy как в VideoForge:
  transient/unknown — один новый вызов, invalid LLM result — до трёх attempts всего.
  Один deadline, новая operation identity, fencing поздних ответов, без старых receipts.
  Account errors выбирают другой профиль, не создают постоянный block/manual-retry gate.
  Client error envelope и журнал attempts; online backup до изменения SQLite schema.
- [x] Flow `upscale_ready` только после готового base: один ACK и отдельное окно
  5 минут; поздние/repeated события не продлевают deadline. Async video не зависит
  от polling. Повтор original download, проверка empty/HTML/JSON; Vids WAV не генерируется
  заново из-за ошибки скачивания одной сцены.
- [ ] Нормализовать существующий React/shadcn shell по Chat2API reference,
  сохранив прежние design tokens. Один renderer desktop/browser.
- [ ] Extension UI на тех же токенах: connection, providers, identity/tier/status,
  без admin/approve/token store и второго набора business state.

Приёмка: UI и внешние клиенты получают один результат/ошибку; tray/Quit
управляют одним API. Donors не меняются.

### UI/storage hardcut и Generator

- [x] Две таблицы: «Профили Chrome» (`/accounts`) и «Провайдеры» (`/providers`).
  Общая раскрывающаяся таблица показывает site identity, Chrome profile,
  Paid/Free/unknown, connection/access и observed health раздельно.
  Pending queue считается один раз на сервере, auto отдельно.
- [x] Chrome identity — optional metadata hello, не ключ профиля. UUID/token и
  автоматический reconnect сохраняются; email не объединяет разные профили.
- [x] Settings: порядок text providers для auto, ↑/↓, Save. Атомарный
  `DATA_DIR/settings.json`: saved → env → defaults. Применяется к следующим
  назначениям без остановки текущих; explicit/media/retry/health не меняются.
- [x] По решению владельца dev storage сброшен без legacy-миграций:
  `app.sqlite3`, таблицы `profiles`, `requests`, `files`, `api_keys`.
  До hardcut создан проверенный SQLite snapshot и сохранена вся прежняя data:
  `.tmp/backups/before-app-db-20261015-182642/`.
  Старые credentials/history/media не удалены, но не импортируются в новую БД.
- [x] Generator (`/generator`, прежний Playground перенаправляет туда):
  форма по типам text/image/video/speech, реальные capabilities и media/text result,
  controls/preview/download; наш generation API без демонстрационных результатов.
- [x] Статистика (`/stats`) по реальному journal: provider/time filters,
  end-to-end latency, success/error counts и группировка errors.
  Reference UX — FastGen; наши design tokens, без SaaS credits/project слоя.
- [ ] Windows Chrome launcher — отдельный будущий этап. Read-only discovery
  `Local State/profile.info_cache`, точная папка профиля, проверенный IPC и
  `spawn(shell:false)`. Email — подсказка, не уникальный physical profile ID.
  Launcher сейчас не реализуется.

Проверки: identity/errors без secrets, очередь без двойного счёта и ограничения
100 последних jobs, 10 profiles × 6 providers, клавиатура/light/dark/mobile;
routing save/restart и назначения во время running job; чистая схема и reopen.
Live smoke и fixtures отмечаются отдельно. Donors не меняются.

Проверка этого этапа: 259 tests passed; typecheck, server/web/desktop build,
обычная и dev-extension build; Desktop и обе MV3 connection smoke прошли.
CRX UI fixtures проходят. Generator проверен с изолированными HTTP responses
для text/image/video/audio; Stats — на отдельной fixture DB с реальным API.
Light/dark и 375–1440px без viewport overflow. Новых vendor generation calls
в этом этапе не было. API на 8001, два прежних profile UUID подключились к новой
БД автоматически. Для Chrome identity metadata требуется reload новой сборки;
Chrome может вернуть пустой email, в этом случае UI показывает «—».

## 3. Все 12 провайдеров

Обновить ChatGPT, Gemini, Qwen и DeepSeek на общий контракт; media не переписывать.
Последовательно добавить оставшиеся шесть:

1. Google AI Studio — отдельный provider, не alias Gemini Web; сначала текст.
2. Z.ai и Kimi — UI Send и capabilities по фактическим возможностям сайтов.
3. Grok — тот же runtime и LLM contract.
4. Meta AI / Muse Spark — один provider, reference MetaAI-Free-Hermes-Agent.
5. Arena — site adapter, reference WebAI2API.

Для каждого:

- [ ] Identity и paid/free/unknown; fresh/temporary chat где поддерживается.
- [ ] Полный prompt, один Send, completed result, abort и provider errors.
- [ ] Default/fast/deep: фактическое переключение либо явная неподдержка до Send.
- [ ] Общий catalog, нужные manifest origins, UI без новых дублирующих экранов.
- [ ] Fixture tests и реальный API → extension → сайт → API smoke.

Имя в registry не означает готовую интеграцию. Дополнительные AI Studio/media
возможности — после проверки реального сайта, не по обещаниям donor README.

## 4. Позже: UI image adapters

- [ ] ChatGPT, Gemini, Qwen и Meta AI/Muse: изучить реальный image flow и ограничения
  аккаунтов. Наличие image-функции пока не означает готовую интеграцию.
- [ ] На общем CRX runtime реализовать UI image-tool → prompt/references → один
  Generate → completed image. Общие ожидания/download/upload не дублировать.
- [ ] Site-specific selectors и получение файла остаются у провайдера;
  HTTP image contract и storage общие с Flow.
- [ ] Проверить реальные файлы и provider errors, timeout/abort без слепого повторного
  Generate. Flow/Vids native transport не менять. Сейчас этот этап не реализуется.

## 5. Проверки и выпуск

- [x] Первый hardcut: `npm run typecheck`, `npm test`, `npm run build` — 172 теста.
  После routing/health: `npm test` — 215 passed; API и dev-extension пересобраны.
- [x] `npm run build:extension:dev` — dev-ID сохранён, manifest version не поднята.
- [x] `npm run smoke:desktop`, `npm run smoke:extension`, `npm run smoke:crx`.
  Browser smoke используют изолированный Chrome for Testing 156 / Playwright 1.64.1;
  локальный test-browser: `.tmp/playwright-browsers`, выбирается через
  `PLAYWRIGHT_BROWSERS_PATH`. Пользовательские Chrome-профили не используются.
- [ ] Live smoke всех LLM: default/fast/deep, paid/free при наличии аккаунтов.
  Записать provider/account/request ID, фактический режим и результат.
- [ ] Live Flow image/video и Vids speech; проверить bytes/content type,
  доступность файлов и внешний HTTP-контракт.
- [ ] Reconnect/reload/cancel/lost connection без duplicate submit и replay.
- [ ] Установка desktop + extension; отсутствие admin/pairing и утечек секретов.
  Перед изменениями storage/schema — backup данных.
- [ ] Проверка license/provenance/notices bundle; donor code не переносить.
  Обновить README по реальному состоянию, не по этому чек-листу.

Commit/push, публикация пакета, release/deploy — только по отдельному запросу.

CRX background fix (2026-10-15): минимальный transport не включал стандартную
Playwright focus emulation. Добавлено при attach, без активации настоящей вкладки.
`scripts/smoke-crx-background.ts` запускает отдельный Chrome без Playwright defaults:
старая схема ждёт foreground/получает timeout, ручная активация запускает ответ;
исправленная — завершается в фоне, сохраняет foreground draft и снимает override
на detach. Повтор с Gemini new_chat navigation также проходит. 260 tests passed.
Это воспроизведение механизма, не трассировка исторических 348 секунд; live Gemini
на аккаунте addriveuz после исправления требует reload новой dev-extension.

Проверено 2026-10-15: OpenAI/Vercel/TanStack JSON+SSE, media wire contract,
browser runtime/files/disconnect, desktop tray/Quit, реальный MV3 hello и CRX DOM
fixtures. Реальных запросов к vendor generation API в этих smoke — 0.
После routing-этапа Flow operations и Vids artifact collection изменены для
upscale stage/error metadata/download retry; native RPC payload и chunk order
проверяются tests. Donors не изменялись.

Live-проверка 2026-10-15: API работает на 8001, подключены два Chrome profiles.
ChatGPT/Gemini/Qwen/DeepSeek вернули SMOKE_OK, Flow вернул JPEG и MP4 (4s, 360p).
Gemini и Qwen успешно перешли на второй profile после UI preparation error.
Два последующих параллельных auto завершились ошибками Gemini new_chat и
ChatGPT send: это незакрытые UI-баги, не успешная приёмка повторных запросов.
Vids generation не запускалась: нет ready аккаунта (ошибка создания фоновой
вкладки на одном profile, PAID_PLAN_REQUIRED на другом). Создание новых provider
tabs изменено на active:true, dev-extension пересобран; требуется reload и
повтор Vids. Существующие вкладки переиспользуются без принудительного фокуса.
Отчёт: `.tmp/live-smoke-1792067325993.json`; CLI: `npm run smoke:live`.
216 tests, TypeScript и isolated MV3 connection smoke проходят.

Повтор после UI fixes: Gemini и ChatGPT — SMOKE_OK с первой попытки; два
параллельных auto — SMOKE_OK на разных Chrome profiles. Отчёт:
`.tmp/live-smoke-1792068240579.json`. Vids native speech вернул WAV 249644 bytes
до добавления явного UI preparation (`.tmp/live-smoke-1792067714265.json`).
Исправлена correlation header потоковых audio/video ответов; HTTP regression
подтверждает, что speech x-request-id равен journal ID, а не случайному ID.
Новый Vids clicker закрывает welcome и открывает voiceover до native transport;
после первого reload обнаружен UI timeout. Добавлены распознавание вложенных
scene labels, конкретный шаг в ошибке и поиск собственного открытого документа
по сохранённому URL при потере tab ID. Последний Vids UI fix требует reload
и ещё не подтверждён настоящим сайтом. Чужие документы не подхватываются.

Последний reload выявил `voiceover_panel` timeout и параллельные debugger attach.
Account-session теперь объединяет одновременно идущие checks; Vids UI использует
подтверждённую native readiness как основной критерий, без обязательных scene tabs
и повторных переключений уже готовой панели. 226 tests проходят, dev bundle готов;
нужны reload последней сборки и повтор живого Vids smoke. Последний live Vids
после прежнего UI fix был blocked, а не успешен.

После следующего reload Vids live smoke прошёл два раза подряд: HTTP 200,
WAV 255404 и 199724 bytes, по одной attempt на том же profile; health.lastSuccess
обновился, connection error пуст, provider ready. Отчёты:
`.tmp/live-smoke-1792068869308.json`, `.tmp/live-smoke-1792068874509.json`.
Speech request IDs совпадают с journal IDs. Ошибка debugger не повторилась
в этих вызовах. Повторное использование сохранённого документа подтверждено
regression test; количество вкладок живого Chrome API не отдаёт, поэтому
отсутствие новых вкладок в пользовательском браузере отдельно не подтверждено.
