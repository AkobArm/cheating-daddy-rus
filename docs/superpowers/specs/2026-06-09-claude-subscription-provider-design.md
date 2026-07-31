# Дизайн: Claude-провайдер (через подписку) для Cheating Daddy

**Дата:** 2026-06-09
**Статус:** на ревью

## Цель

Добавить в Cheating Daddy четвёртый AI-провайдер — **Claude через подписку Claude.ai (Pro/Max)** —
работающий по UX идентично текущему Gemini: приложение слушает звук собеседника, автоматически
(по детекции конца реплики) отправляет распознанный текст в Claude и быстро стримит ответ в оверлей.
Hands-free, без хоткеев и ручного ввода.

## Ключевые решения (зафиксированы с пользователем)

| Вопрос | Решение |
|---|---|
| Авторизация | Свой OAuth-PKCE-логин внутри приложения (кнопка Login → браузер claude.ai → loopback-callback). Не требует установленного Claude Code. |
| Аудио | Whisper+VAD из `localai.js` транскрибирует локально → текст → Claude. Continuous, как Gemini. |
| Модель | Дропдаун в UI; дефолт `claude-sonnet-4-6`. Опции: Sonnet 4.6 / Opus 4.8 / Haiku 4.5. |
| Вызов API | `@anthropic-ai/sdk` с `authToken` (OAuth-режим) + `anthropic-beta: oauth-2025-04-20`, стриминг `messages.stream()`. |
| Переиспользование транскрипции | Вынести стадию `transcribe()` из `localai.js` в экспортируемую функцию (минимальный рефактор). |

## Технические факты (основание дизайна)

- **У Claude нет realtime-audio API.** Anthropic Messages API принимает только текст + изображения.
  Поэтому аудио транскрибируется локально (Whisper), как в `local`-провайдере, а в Claude уходит текст.
  UX «услышал → ответил» сохраняется за счёт VAD-детекции конца реплики (уже реализована в `localai.js`).
- **OAuth по подписке.** Claude Code логинится через OAuth2 authorization-code + PKCE против claude.ai,
  client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`, scope включает `user:inference`. Запросы идут на
  `api.anthropic.com` с `Authorization: Bearer <accessToken>` и `anthropic-beta: oauth-2025-04-20`
  (без `x-api-key`).
  > ⚠️ Точные значения token-endpoint, redirect_uri и полного набора scope **верифицируются по коду
  > при реализации** — в спеке не фиксируются как истина, чтобы не закладывать догадку.
- **Риск.** Запросы под client_id Claude Code = нарушение ToS Anthropic и риск бана аккаунта/подписки.
  Пользователь проинформирован и принял риск.

## Контракт провайдера (из анализа существующих трёх)

Новый провайдер обязан реализовать тот же интерфейс, что `gemini`/`cloud`/`local`:

- IPC-инициализация: `ipcMain.handle('initialize-claudecode', (e, ...) => ...)` → `boolean`.
- Приём ввода через общие каналы в `gemini.js`: `send-audio-content`, `send-image-content`,
  `send-text-message` — с веткой на `currentProviderMode === 'claudecode'`.
- Вывод через IPC-события в renderer: `new-response` (первый чанк), `update-response`
  (накопленный текст), `update-status`.
- Lifecycle: участие в `initializeNewSession()`, `saveConversationTurn()`, `close-session`.
- Выбор провайдера: `preferences.providerMode = 'claudecode'`, диспетчеризация в
  `CheatingDaddyApp.js → handleStart()`.

## Компоненты и файлы

### Новые

**`src/utils/claudeAuth.js`** — OAuth-PKCE.
- `generatePkce()` → `{verifier, challenge}` (S256).
- `startLogin()` → открывает authorize-URL во внешнем браузере, поднимает loopback HTTP-сервер на
  `127.0.0.1:<port>` для приёма `code`, обменивает `code` на токен, сохраняет в storage.
- `getValidAccessToken()` → возвращает действительный `accessToken`, при необходимости рефрешит по
  `refreshToken`/`expiresAt`.
- `logout()` → чистит сохранённый токен.
- Что делает: инкапсулирует весь OAuth. Зависит от: `storage.js` (хранение токена), Electron `shell`
  (открыть браузер), node `http`/`crypto`.

**`src/utils/claudecode.js`** — провайдер.
- `connectClaudeCode(profile, userContext)` → инициализирует SDK-клиент с `authToken` из `claudeAuth`,
  системным промптом профиля, моделью из prefs. → `boolean`.
- `sendClaudeCodeAudio(pcmBuffer)` → `transcribe()` → накопление реплики → по концу реплики (VAD)
  `sendClaudeCodeText(text)`.
- `sendClaudeCodeText(text)` → формирует messages (system + последние N турнов + текст), запускает
  `messages.stream()`, ретранслирует чанки в `new-response`/`update-response`, по завершении —
  `saveConversationTurn()`.
- `sendClaudeCodeImage(base64)` → добавляет image-блок к следующему запросу.
- `closeClaudeCode()`, `isClaudeCodeActive()`.
- Что делает: единственная точка, знающая про Anthropic SDK и формат сообщений. Зависит от:
  `@anthropic-ai/sdk`, `claudeAuth`, `localai.transcribe`, `prompts.js`.

### Изменяемые

**`src/utils/localai.js`** — вынести стадию транскрипции в экспортируемую `transcribe(audioChunk) → text|null`
(Whisper-инференс + ресемпл 24→16k + VAD-сегментация), чтобы её разделяли Ollama и Claude. Поведение
Ollama-пути не меняется.

**`src/utils/gemini.js`** — добавить `initialize-claudecode` IPC-handler; ветки `claudecode` в
обработчиках `send-audio-content` / `send-image-content` / `send-text-message` и в `close-session`.

**`src/storage.js`** — `DEFAULT_CREDENTIALS.claudeOAuth = { accessToken, refreshToken, expiresAt, scopes }`;
`DEFAULT_PREFERENCES.claudeModel = 'claude-sonnet-4-6'`. IPC get/set по аналогии с существующими.

**`src/components/views/AICustomizeView.js`** (и карточка провайдера в `MainView.js`) — кнопка
«Login with Claude» + индикатор статуса (залогинен / истёк / нет) + дропдаун модели. Выбор провайдера
проставляет `providerMode = 'claudecode'`.

**`package.json`** — зависимость `@anthropic-ai/sdk`.

## Поток данных

```
Системный звук → renderer (24kHz PCM base64) → IPC send-audio-content
  → gemini.js (ветка claudecode) → claudecode.sendClaudeCodeAudio
  → localai.transcribe (Whisper, 24→16k, VAD: детекция конца реплики)
  → текст реплики собеседника
  → claudecode.sendClaudeCodeText: messages.stream() в Claude
       (authToken + anthropic-beta, system=профиль, history=последние N турнов)
  → стрим токенов → new-response / update-response → оверлей
Скриншот → IPC send-image-content → image-блок в следующем запросе
```

## Управление контекстом

Messages API stateless. Каждый запрос собирается заново:
- `system` — промпт профиля из `prompts.js` (Interview/Sales/...).
- `messages` — последние N турнов из истории сессии (`saveConversationTurn` уже хранит turns);
  обрезка по N последних для контроля окна контекста.
- текущий скриншот (если был) как image-блок в последнем user-сообщении.

## Обработка ошибок

- Проактивно: перед запросом `getValidAccessToken()` рефрешит токен, если близко к `expiresAt`.
- 401 от API → одна попытка refresh + повтор; повторный 401 → `update-status` «нужен ре-логин»,
  сессия не валится.
- Сетевые / 5xx → лог + `update-status`, запрос тихо теряется (как в остальных провайдерах,
  publish-ошибки не пробрасываются).

## Тестирование

В проекте нет тестового раннера (`npm run lint` — заглушка, тестов нет). Объём тестов минимальный:
- Чистые функции `claudeAuth`: генерация PKCE-challenge (S256 корректность), логика «истёк ли токен»
  по `expiresAt`, разбор token-ответа. Без сети, можно гонять обычным node-скриптом.
- Реалтайм-путь (звук → транскрипция → ответ) проверяется ручным прогоном `npm start`.

## Вне объёма (YAGNI)

- Чтение токена из установленного Claude Code / Keychain (выбрали свой OAuth).
- Tool use / agentic-возможности Claude Code (нужен только chat-ответ).
- Большой рефактор `localai.js` в pluggable-pipeline (достаточно вынести одну функцию).
- Хранение токена в системном Keychain вместо storage.js (можно как последующее усиление безопасности).
