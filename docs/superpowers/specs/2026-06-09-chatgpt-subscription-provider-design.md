# ChatGPT-подписка как провайдер инференса

**Дата:** 2026-06-09
**Статус:** утверждается
**Ветка:** fix-local

## Цель

Добавить в cheating-daddy полноценный провайдер на базе **ChatGPT Plus/Pro подписки**
(Codex backend), аналогично провайдерам Gemini Live / Groq / Ollama. Авторизация — через
OAuth (PKCE) как в Codex CLI; токен реально используется для генерации ответов.

За основу взят подход openclaw (`src/llm/utils/oauth/openai-chatgpt*.ts`) и открытый
исходник `openai/codex` (`codex-rs/login`). Дословные файлы openclaw — тонкие адаптеры,
реальные константы берутся из codex.

## Контекст / текущее состояние

- В проекте уже есть `src/utils/openaiOAuth.js` — **generic** OAuth, не «Codex subscription»:
  требует BYO `client_id`, неверные scopes (`model.request api.responses.write`), account_id
  читает из `payload.account_id || sub`, нет token-exchange, токен **нигде не используется**.
  Подключён только как connect/disconnect/status (кнопки в `CustomizeView`, IPC в `index.js`).
- Провайдеры выбираются через `preferences.providerMode` ∈ `byok` (Gemini Live) / `local`
  (Ollama+Whisper) / `cloud`. Ветвление — в `CheatingDaddyApp.handleStart`.
- `localai.js` — шаблон для нового провайдера: `initializeLocalSession` → `processLocalAudio`
  (VAD+Whisper) → `sendToOllama` (стрим через `new-response`/`update-response`) →
  `closeLocalSession`, плюс `sendLocalImage`, `setLatestScreenshot`, коалесцер очереди.

**Ключевое ограничение:** ChatGPT-подписка не предоставляет realtime-audio API (как Gemini
Live). Поэтому провайдер строится на пайплайне `local`: аудио → Whisper-транскрипция →
текст(+скриншот) → backend → стрим текста назад.

## Подтверждённые константы (из openai/codex)

- issuer `https://auth.openai.com`; authorize `/oauth/authorize`; token `/oauth/token`
- redirect `http://localhost:1455/auth/callback`; PKCE `code_challenge_method=S256`
- scope: `openid profile email offline_access api.connectors.read api.connectors.invoke`
- доп. параметры authorize: `id_token_add_organizations=true`,
  `codex_cli_simplified_flow=true`, `originator=<codex originator>`
- после authorization_code → `{ id_token, access_token, refresh_token }`, затем
  token-exchange id_token'а для рабочего ключа (`obtain_api_key`)
- account_id — JWT-claim `https://api.openai.com/auth` → `chatgpt_account_id`
- credential-форма (из openclaw): `{ access, refresh, expires, accountId }`

**Допиливается на этапе плана** (читается из codex-исходников, не выдумывается): точная строка
`CLIENT_ID`, тело token-exchange, схема payload `codex/responses`, backend base-URL,
id модели (`gpt-5-codex` / `gpt-5`).

## Риск (принятое решение)

Эндпоинт `codex/responses` — Codex-специфичный бэкенд подписки и серая зона по ToS OpenAI.
**Решение пользователя:** маскируемся под Codex CLI — шлём запросы в точности как Codex
(originator, формат `instructions`/payload), наш системный промпт прокидываем внутрь. Это
даёт максимальный шанс совместимости.

## Архитектура

### Модули

**1. `src/utils/openaiOAuth.js` (переписать под Codex)**
- Зашитый `CLIENT_ID`, issuer, redirect, PKCE, scope и доп.параметры authorize как у codex.
- token-exchange id_token → рабочий ключ.
- `accountId` из claim `https://api.openai.com/auth.chatgpt_account_id`.
- refresh по refresh_token; `ensureValidOpenAIAuth` перед сессией/запросом.
- Убрать BYO `client_id` и нерабочий `startOpenAIBrowserSignin` (делает второй PKCE, не
  матчащийся с callback'ом).
- Экспорт чистых функций для тестов: `decodeJwtPayload`, `resolveAccountId`, `buildAuthUrl`,
  `normalizeTokenResponse`.

**2. `src/utils/transcription.js` (новый — вынести из localai.js)**
Общий пайплайн: Whisper-загрузчик, VAD, resample 24k→16k, `transcribeAudio`,
`isNoiseTranscription`. Потребители — `localai.js` и `chatgptai.js`. `localai.js`
рефакторится на использование этого модуля (поведение не меняется).

**3. `src/utils/chatgptai.js` (новый — зеркало localai.js)**
- `initializeChatGPTSession(profile, customPrompt, language, model)` — ensure valid OAuth,
  поднять транскрипцию, system-prompt из `prompts.js`.
- `processChatGPTAudio(chunk)` → транскрипция → коалесцер (отвечаем только на последний
  вопрос) → `sendToChatGPT`.
- `sendToChatGPT(text)` — POST на codex/responses; заголовки `Authorization: Bearer <access>`,
  `chatgpt-account-id: <accountId>`, `OpenAI-Beta: responses=experimental`,
  `originator`, `session_id`; payload codex-формы (`instructions` = промпт, input = текст).
  Парсинг SSE → стрим `new-response`/`update-response`.
- `sendChatGPTImage(base64, prompt)` — input с картинкой.
- `closeChatGPTSession`, `isChatGPTSessionActive`, `setLatestScreenshot`.

**4. Проводка**
- `index.js`: IPC `initialize-chatgpt`, роутинг аудио/картинок к chatgpt при активной сессии,
  `ensureValidOpenAIAuth` перед стартом.
- `renderer.js`: `initializeChatGPT(profile)` + маршрутизация capture к chatgpt-провайдеру.
- `CheatingDaddyApp.handleStart`: ветка `providerMode === 'chatgpt'` с проверкой `connected`
  (иначе — подсказка подключить аккаунт).
- `MainView`: пункт «ChatGPT (подписка)» в выборе провайдера.
- `CustomizeView`: упростить — убрать поле ввода client_id, оставить connect/disconnect/status.
- `storage.js`: форма credential'а `openaiOAuth`, убрать неиспользуемые prefs
  (`openaiOauthClientId`, `openaiOauthScopes`), добавить `chatgptModel`.

### Поток данных

```
audio 24k → resample 16k → VAD → Whisper → text → coalesce
          → sendToChatGPT → codex/responses (SSE) → new/update-response
screenshot → sendChatGPTImage → (тот же SSE-стрим)
```

### Обработка ошибок

- OAuth протух → refresh; refresh упал → статус «disconnected» + предложить переподключение.
- Backend 401 → refresh + один ретрай; 403/ToS-реджект → понятная ошибка пользователю.
- Сеть / SSE-обрыв → `update-status` с сообщением.
- Publish-ошибки транскрипции/инференса логируются, не валят сессию (Listening продолжается).

### Тесты

В проекте нет тест-раннера. Добавляем **минимальные node-проверки** (без новых зависимостей):
отдельный скрипт проверяет чистые функции `openaiOAuth.js` — декод JWT, resolve account-id,
сборку authorize-URL (наличие правильных scope/params), нормализацию token-ответа. Запуск
вручную: `node scripts/test-openai-oauth.js`. Сетевые/SSE-части проверяются руками через
`npm start`.

## Границы (что НЕ делаем)

- Не трогаем существующие провайдеры Gemini/Groq/Ollama, кроме выноса транскрипции.
- Не добавляем vitest / CI.
- Не реализуем альтернативный путь через api.openai.com (решено маскироваться под codex).

## Критерии готовности

1. Кнопка Connect открывает браузер, OAuth по PKCE проходит, токен+accountId сохранены
   (зашифрованы через `safeStorage`).
2. `providerMode='chatgpt'` стартует сессию, транскрибирует речь, шлёт в codex/responses,
   стримит ответ в overlay.
3. Скриншот уходит как image-input и учитывается в ответе.
4. Протухший токен автоматически рефрешится перед запросом.
5. node-проверки чистых функций OAuth проходят.
6. `npm install && npm start` работает.
