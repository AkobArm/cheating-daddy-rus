# ChatGPT Subscription Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ChatGPT Plus/Pro subscription provider to cheating-daddy that authenticates via Codex-style OAuth (PKCE) and generates streamed assistant responses through the ChatGPT Codex backend.

**Architecture:** Reuse the existing `local` (Ollama+Whisper) pipeline shape. Audio is transcribed locally (Whisper), text+screenshots are sent to `https://chatgpt.com/backend-api/codex/responses` (SSE), masquerading as Codex CLI (originator `codex_cli_rs`, codex-shaped payload). OAuth is rewritten to use the real Codex public client and constants. The Whisper/VAD pipeline is extracted from `localai.js` into a shared `transcription.js` consumed by both `localai.js` and the new `chatgptai.js`.

**Tech Stack:** Electron (main+renderer), Node `http`/`crypto`/`fetch`, Lit web components, Whisper via `@huggingface/transformers`, `safeStorage` for secrets.

---

## Verified constants (from openai/codex, do not change without re-checking source)

```
CLIENT_ID            = app_EMoamEEZ73f0CkXaXp7hrann      (login/src/auth/manager.rs:1009)
ISSUER               = https://auth.openai.com
AUTHORIZE            = https://auth.openai.com/oauth/authorize
TOKEN                = https://auth.openai.com/oauth/token
REDIRECT             = http://localhost:1455/auth/callback   (path /auth/callback, port 1455)
SCOPES               = openid profile email offline_access api.connectors.read api.connectors.invoke
ORIGINATOR           = codex_cli_rs                       (auth/default_client.rs:36)
BACKEND_BASE         = https://chatgpt.com/backend-api/codex
RESPONSES_ENDPOINT   = /responses   -> https://chatgpt.com/backend-api/codex/responses
ACCOUNT_ID_CLAIM     = https://api.openai.com/auth -> chatgpt_account_id (decoded from id_token)
```

**Authorize query params** (all required):
`response_type=code`, `client_id`, `redirect_uri`, `scope`, `code_challenge`,
`code_challenge_method=S256`, `id_token_add_organizations=true`,
`codex_cli_simplified_flow=true`, `originator=codex_cli_rs`, `state`.

**Token exchange (authorization_code), body x-www-form-urlencoded:**
`grant_type=authorization_code&code=<code>&redirect_uri=<redirect>&client_id=<CLIENT_ID>&code_verifier=<verifier>`
→ returns `{ id_token, access_token, refresh_token }`.

**Refresh, body x-www-form-urlencoded:**
`grant_type=refresh_token&refresh_token=<refresh>&client_id=<CLIENT_ID>&scope=openid profile email`

**Responses request:** `POST https://chatgpt.com/backend-api/codex/responses`
Headers:
```
Authorization: Bearer <access_token>
chatgpt-account-id: <accountId>
OpenAI-Beta: responses=experimental
originator: codex_cli_rs
session_id: <uuid v4 per session>
Content-Type: application/json
Accept: text/event-stream
```
Body (minimal codex-shaped):
```json
{
  "model": "<chatgptModel pref>",
  "instructions": "<system prompt from prompts.js>",
  "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"<transcription>"}]}],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true,
  "include": []
}
```
For an image turn, append to the single user message `content` array:
`{"type":"input_image","image_url":"data:image/jpeg;base64,<base64>"}`.

> NOTE: `OpenAI-Beta` value and the exact accepted `model` slug are validated in Task 9 (manual smoke test). Default model `gpt-5`; fallback to try `gpt-5-codex` if the backend rejects the model.

---

## File Structure

- **Modify** `src/utils/openaiOAuth.js` — rewrite to Codex OAuth; export pure helpers for tests.
- **Create** `scripts/test-openai-oauth.js` — node assert tests for OAuth pure functions.
- **Create** `src/utils/transcription.js` — Whisper loader + VAD + resample + transcribe + noise filter (extracted from localai.js).
- **Modify** `src/utils/localai.js` — consume `transcription.js` (behavior unchanged).
- **Create** `src/utils/chatgptai.js` — ChatGPT provider (init / audio / sendToChatGPT SSE / image / close).
- **Modify** `src/index.js` — OAuth IPC cleanup; `initialize-chatgpt` IPC; route audio/image to chatgpt.
- **Modify** `src/utils/renderer.js` — `initializeChatGPT`; route capture to chatgpt.
- **Modify** `src/storage.js` — credential shape; drop `openaiOauthClientId`/`openaiOauthScopes`; add `chatgptModel`.
- **Modify** `src/components/views/MainView.js` — add "ChatGPT (subscription)" provider option.
- **Modify** `src/components/app/CheatingDaddyApp.js` — `handleStart` branch for `providerMode==='chatgpt'`.
- **Modify** `src/components/views/CustomizeView.js` — remove client_id input; keep connect/disconnect/status.

---

## Task 1: Rewrite `openaiOAuth.js` with Codex constants + pure helpers

**Files:**
- Modify: `src/utils/openaiOAuth.js`

- [ ] **Step 1: Replace the constants block (top of file).**

Replace lines defining `AUTH_URL`/`TOKEN_URL`/`DEFAULT_SCOPES`/`DEFAULT_REDIRECT_PORT`/`DEFAULT_REDIRECT_PATH` with:

```javascript
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const AUTH_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'];
const ORIGINATOR = 'codex_cli_rs';
const REDIRECT_PORT = 1455;
const REDIRECT_PATH = '/auth/callback';
const ACCOUNT_ID_CLAIM = 'https://api.openai.com/auth';
```

- [ ] **Step 2: Rewrite `buildAuthUrl` to include codex params.**

```javascript
function buildAuthUrl({ redirectUri, state, codeChallenge }) {
    const url = new URL(AUTH_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', ORIGINATOR);
    url.searchParams.set('state', state);
    return url.toString();
}
```

- [ ] **Step 3: Add `resolveAccountId` pure helper (uses existing `decodeJwtPayload`).**

```javascript
function resolveAccountId(idToken) {
    const payload = decodeJwtPayload(idToken);
    const claim = payload && payload[ACCOUNT_ID_CLAIM];
    const accountId = claim && claim.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : '';
}
```

- [ ] **Step 4: Rewrite `exchangeToken` to codex bodies (no redirect for refresh).**

```javascript
async function exchangeToken({ code, codeVerifier, redirectUri, grantType = 'authorization_code', refreshToken = '' }) {
    const body = new URLSearchParams();
    body.set('client_id', CLIENT_ID);
    body.set('grant_type', grantType);
    if (grantType === 'authorization_code') {
        body.set('code', code);
        body.set('redirect_uri', redirectUri);
        body.set('code_verifier', codeVerifier);
    } else {
        body.set('refresh_token', refreshToken);
        body.set('scope', 'openid profile email');
    }
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data.error_description || data.error || `OAuth token request failed (${response.status})`;
        throw new Error(message);
    }
    return data;
}
```

- [ ] **Step 5: Rewrite `normalizeTokenResponse` to use id_token account claim.**

```javascript
function normalizeTokenResponse(tokenResponse, existingAuth = null) {
    const idToken = tokenResponse.id_token || existingAuth?.idToken || '';
    const payload = decodeJwtPayload(tokenResponse.access_token || idToken || '');
    const now = Date.now();
    const expiresIn = Number.parseInt(tokenResponse.expires_in, 10);
    const expiresAt = Number.isFinite(expiresIn) ? now + expiresIn * 1000 : existingAuth?.expiresAt || 0;
    const accountId = resolveAccountId(idToken) || existingAuth?.accountId || '';
    const accountEmail = payload.email || existingAuth?.accountEmail || '';

    return {
        provider: 'openai',
        accountId,
        accountEmail,
        displayName: accountEmail || accountId || 'ChatGPT account',
        tokenType: tokenResponse.token_type || 'Bearer',
        accessToken: tokenResponse.access_token || existingAuth?.accessToken || '',
        refreshToken: tokenResponse.refresh_token || existingAuth?.refreshToken || '',
        idToken,
        expiresAt,
        createdAt: existingAuth?.createdAt || now,
        updatedAt: now,
    };
}
```

- [ ] **Step 6: Simplify `connectOpenAI` (no clientId/preferences; fixed port/redirect).**

```javascript
async function connectOpenAI({ existingAuth = null } = {}) {
    const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;
    const state = base64UrlEncode(crypto.randomBytes(24));
    const { verifier, challenge } = createPkcePair();
    const authUrl = buildAuthUrl({ redirectUri, state, codeChallenge: challenge });

    const callback = waitForOAuthCallback(REDIRECT_PORT, state);
    try {
        await shell.openExternal(authUrl);
    } catch (error) {
        callback.close();
        throw error;
    }

    const { code } = await callback.promise;
    const tokenResponse = await exchangeToken({ code, codeVerifier: verifier, redirectUri });
    const auth = normalizeTokenResponse(tokenResponse, existingAuth);
    storage.setOpenaiOAuth(auth);
    return auth;
}
```

> Keep `REDIRECT_PATH`/`REDIRECT_PORT` consistent inside `waitForOAuthCallback` (it currently uses `DEFAULT_REDIRECT_PATH`). Update that reference to `REDIRECT_PATH`.

- [ ] **Step 7: Rewrite `refreshOpenAIAuth` (no clientId/redirect args).**

```javascript
async function refreshOpenAIAuth(existingAuth) {
    if (!existingAuth?.refreshToken) {
        throw new Error('No refresh token stored');
    }
    const tokenResponse = await exchangeToken({ grantType: 'refresh_token', refreshToken: existingAuth.refreshToken });
    const auth = normalizeTokenResponse(tokenResponse, existingAuth);
    storage.setOpenaiOAuth(auth);
    return auth;
}
```

- [ ] **Step 8: Simplify `ensureValidOpenAIAuth` (no args) and delete `startOpenAIBrowserSignin`.**

```javascript
async function ensureValidOpenAIAuth() {
    const auth = storage.getOpenaiOAuth();
    if (!auth) return null;
    if (auth.expiresAt && auth.expiresAt > Date.now() + 60_000) return auth;
    if (!auth.refreshToken) return auth;
    return refreshOpenAIAuth(auth);
}
```

Remove the entire `startOpenAIBrowserSignin` function.

- [ ] **Step 9: Update `module.exports`.**

```javascript
module.exports = {
    connectOpenAI,
    disconnectOpenAI,
    ensureValidOpenAIAuth,
    getOpenAIAuthStatus,
    refreshOpenAIAuth,
    // pure helpers (exported for tests)
    buildAuthUrl,
    decodeJwtPayload,
    resolveAccountId,
    normalizeTokenResponse,
    CLIENT_ID,
    SCOPES,
    REDIRECT_PORT,
    REDIRECT_PATH,
};
```

- [ ] **Step 10: Commit.**

```bash
git add src/utils/openaiOAuth.js
git commit -m "feat(oauth): rewrite OpenAI OAuth to Codex subscription flow"
```

---

## Task 2: Node tests for OAuth pure functions

**Files:**
- Create: `scripts/test-openai-oauth.js`

- [ ] **Step 1: Write the failing test.**

```javascript
// Run: node scripts/test-openai-oauth.js
const assert = require('assert');
const crypto = require('crypto');

// Stub electron + storage so the module loads outside Electron.
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { shell: { openExternal: async () => {} }, safeStorage: { isEncryptionAvailable: () => false } };
    return origLoad.apply(this, arguments);
};

const oauth = require('../src/utils/openaiOAuth');

function makeJwt(payloadObj) {
    const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${b64({ alg: 'none' })}.${b64(payloadObj)}.sig`;
}

// 1. buildAuthUrl carries the codex params + client id + scope
const url = oauth.buildAuthUrl({ redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 'st', codeChallenge: 'cc' });
assert.ok(url.includes('client_id=app_EMoamEEZ73f0CkXaXp7hrann'), 'client_id present');
assert.ok(url.includes('code_challenge_method=S256'), 'S256');
assert.ok(url.includes('id_token_add_organizations=true'), 'org param');
assert.ok(url.includes('codex_cli_simplified_flow=true'), 'simplified flow');
assert.ok(url.includes('originator=codex_cli_rs'), 'originator');
assert.ok(url.includes('api.connectors.read'), 'scope present');

// 2. resolveAccountId reads the chatgpt claim
const idToken = makeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123' }, email: 'a@b.c' });
assert.strictEqual(oauth.resolveAccountId(idToken), 'acct_123', 'account id from claim');
assert.strictEqual(oauth.resolveAccountId('garbage'), '', 'no account id -> empty');

// 3. normalizeTokenResponse maps fields + expiry
const norm = oauth.normalizeTokenResponse({ access_token: 'AT', refresh_token: 'RT', id_token: idToken, expires_in: 3600 });
assert.strictEqual(norm.accessToken, 'AT');
assert.strictEqual(norm.refreshToken, 'RT');
assert.strictEqual(norm.accountId, 'acct_123');
assert.strictEqual(norm.accountEmail, 'a@b.c');
assert.ok(norm.expiresAt > Date.now(), 'expiresAt in future');

console.log('OK: all openaiOAuth pure-function tests passed');
```

- [ ] **Step 2: Run to verify it fails first (before Task 1 is complete) or passes now.**

Run: `node scripts/test-openai-oauth.js`
Expected (after Task 1): `OK: all openaiOAuth pure-function tests passed`

- [ ] **Step 3: Commit.**

```bash
git add scripts/test-openai-oauth.js
git commit -m "test(oauth): add node tests for OAuth pure functions"
```

---

## Task 3: Storage + OAuth IPC cleanup

**Files:**
- Modify: `src/storage.js`
- Modify: `src/index.js`

- [ ] **Step 1: In `src/storage.js`, edit `DEFAULT_PREFERENCES`** — remove `openaiOauthClientId`, `openaiOauthRedirectPort`, `openaiOauthScopes`; add `chatgptModel`.

Replace those three lines (`storage.js:36-38`) with:

```javascript
    chatgptModel: 'gpt-5',
```

- [ ] **Step 2: In `src/index.js`, simplify the OAuth IPC handlers** to drop `clientId`/`preferences` args.

Find the `oauth:get-openai-status` / `oauth:connect-openai` / `oauth:start-openai-browser-signin` handlers (around `index.js:360-420`). Replace them with:

```javascript
    ipcMain.handle('oauth:get-openai-status', async () => {
        try {
            await ensureValidOpenAIAuth();
        } catch (error) {
            console.warn('OpenAI auth refresh failed:', error.message);
        }
        return { success: true, data: getOpenAIAuthStatus() };
    });

    ipcMain.handle('oauth:connect-openai', async () => {
        try {
            const auth = await connectOpenAI({ existingAuth: storage.getOpenaiOAuth() });
            return { success: true, data: getOpenAIAuthStatus(), accountEmail: auth.accountEmail };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('oauth:disconnect-openai', async () => {
        await disconnectOpenAI();
        return { success: true, data: getOpenAIAuthStatus() };
    });
```

- [ ] **Step 3: Update the import in `index.js:8`** — remove `startOpenAIBrowserSignin`.

```javascript
const { connectOpenAI, disconnectOpenAI, getOpenAIAuthStatus, ensureValidOpenAIAuth } = require('./utils/openaiOAuth');
```

- [ ] **Step 4: Remove the now-dead `oauth:start-openai-browser-signin` IPC** in `index.js` and its renderer wrapper `startOpenAIBrowserSignin` in `src/utils/renderer.js:133-135`.

- [ ] **Step 5: Run the OAuth tests still pass.**

Run: `node scripts/test-openai-oauth.js`
Expected: `OK: all openaiOAuth pure-function tests passed`

- [ ] **Step 6: Commit.**

```bash
git add src/storage.js src/index.js src/utils/renderer.js
git commit -m "refactor(oauth): drop BYO client id and browser-signin path"
```

---

## Task 4: Extract `transcription.js` from `localai.js`

**Files:**
- Create: `src/utils/transcription.js`
- Modify: `src/utils/localai.js`

- [ ] **Step 1: Create `src/utils/transcription.js`** exporting the audio pipeline. Move these from `localai.js` (verbatim, keep behavior): `resample24kTo16k`, `calculateRMS`, `pcm16ToFloat32`, `loadWhisperPipeline`, `transcribeAudio`, `isNoiseTranscription`. Inject `sendToRenderer` via parameter to avoid a circular dep on `gemini.js`.

```javascript
// src/utils/transcription.js
const { pipeline, env } = require('@huggingface/transformers');

let whisperPipeline = null;
let whisperModelName = null;

function resample24kTo16k(inputBuffer) { /* MOVE body from localai.js:46 */ }
function calculateRMS(pcm16Buffer) { /* MOVE body from localai.js:76 */ }
function pcm16ToFloat32(pcm16Buffer) { /* MOVE body from localai.js:164 */ }

async function loadWhisperPipeline(modelName, sendToRenderer) { /* MOVE body from localai.js:126, replace bare sendToRenderer calls with the param */ }
async function transcribeAudio(pcm16kBuffer, sendToRenderer) { /* MOVE body from localai.js:173 */ }
function isNoiseTranscription(text) { /* MOVE body from localai.js:230 */ }

function resetWhisper() { whisperPipeline = null; whisperModelName = null; }

module.exports = {
    resample24kTo16k,
    calculateRMS,
    pcm16ToFloat32,
    loadWhisperPipeline,
    transcribeAudio,
    isNoiseTranscription,
    resetWhisper,
};
```

> When moving, replace every `sendToRenderer(...)` call inside the moved functions with the passed-in `sendToRenderer` argument. Keep the existing `whisperPipeline`/`whisperModelName` module-level caching semantics.

- [ ] **Step 2: In `localai.js`, replace the moved functions with imports.**

At the top of `localai.js`, after the existing `gemini` require, add:

```javascript
const transcription = require('./transcription');
```

Delete the moved function definitions from `localai.js`. Update call sites:
- `transcription.resample24kTo16k(...)`, `transcription.calculateRMS(...)`, `transcription.pcm16ToFloat32(...)`, `transcription.isNoiseTranscription(...)`.
- `await transcription.loadWhisperPipeline(modelName, sendToRenderer)`.
- `await transcription.transcribeAudio(pcm16kBuffer, sendToRenderer)`.

- [ ] **Step 3: Smoke-check the local provider still loads (syntax + require graph).**

Run: `node -e "require('./src/utils/localai.js'); console.log('localai loads')"`
Expected: `localai loads` (no MODULE_NOT_FOUND / circular errors). If `@huggingface/transformers` throws on bare require, wrap the require in `transcription.js` lazily inside `loadWhisperPipeline` instead of top-level.

- [ ] **Step 4: Commit.**

```bash
git add src/utils/transcription.js src/utils/localai.js
git commit -m "refactor(local): extract shared Whisper/VAD pipeline into transcription.js"
```

---

## Task 5: Create `chatgptai.js` provider

**Files:**
- Create: `src/utils/chatgptai.js`

- [ ] **Step 1: Module skeleton, state, and session lifecycle.**

```javascript
const crypto = require('crypto');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const { getSystemPrompt } = require('./prompts');
const transcription = require('./transcription');
const { ensureValidOpenAIAuth } = require('./openaiOAuth');
const storage = require('../storage');

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';

// VAD constants mirror localai.js
const SILENCE_RMS = 0.01;
const SILENCE_FRAMES = 15;

let session = null; // { systemPrompt, model, sessionId, audioBuffer, speechFrames, silenceCount, isSpeaking }
let latestScreenshot = null;
let isGenerating = false;
let pendingTranscription = null;

function isChatGPTSessionActive() {
    return session !== null;
}

function setLatestScreenshot(base64Data) {
    latestScreenshot = base64Data;
}
```

- [ ] **Step 2: `initializeChatGPTSession`.**

```javascript
async function initializeChatGPTSession(profile = 'interview', customPrompt = '', language = 'en-US', model = 'gpt-5') {
    sendToRenderer('session-initializing', true);
    try {
        const auth = await ensureValidOpenAIAuth();
        if (!auth || !auth.accessToken) {
            sendToRenderer('session-initializing', false);
            sendToRenderer('update-status', 'ChatGPT account not connected');
            return false;
        }
        const systemPrompt = getSystemPrompt(profile, customPrompt, false) + languageDirective(language);
        session = {
            systemPrompt,
            model,
            sessionId: crypto.randomUUID(),
            audioBuffer: [],
            speechFrames: 0,
            silenceCount: 0,
            isSpeaking: false,
        };
        isGenerating = false;
        pendingTranscription = null;
        initializeNewSession();
        // Warm the Whisper model
        const whisperModel = (await storage.getPreferences?.() || {}).whisperModel || 'Xenova/whisper-base/tiny';
        await transcription.loadWhisperPipeline(whisperModel, sendToRenderer);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'ChatGPT ready - Listening...');
        return true;
    } catch (error) {
        session = null;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'ChatGPT error: ' + error.message);
        return false;
    }
}

function languageDirective(locale) {
    if (!locale || locale === 'en-US') return '';
    return `\n\nRespond in ${locale}.`;
}
```

> `getSystemPrompt` signature: confirm in `src/utils/prompts.js`. If it differs, adapt the call. Reuse the same call shape `localai.js:initializeLocalSession` uses.

- [ ] **Step 3: Audio ingestion + VAD (mirror localai `processLocalAudio`/`processVAD`).**

```javascript
function processChatGPTAudio(monoChunk24k) {
    if (!session) return;
    const pcm16k = transcription.resample24kTo16k(monoChunk24k);
    const rms = transcription.calculateRMS(pcm16k);
    session.audioBuffer.push(pcm16k);
    if (rms > SILENCE_RMS) {
        if (!session.isSpeaking) {
            session.isSpeaking = true;
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
        session.silenceCount = 0;
        session.speechFrames++;
    } else if (session.isSpeaking) {
        session.silenceCount++;
        if (session.silenceCount >= SILENCE_FRAMES) {
            const audio = Buffer.concat(session.audioBuffer);
            session.audioBuffer = [];
            session.isSpeaking = false;
            session.silenceCount = 0;
            session.speechFrames = 0;
            handleSpeechEnd(audio);
        }
    } else {
        // keep buffer bounded during silence
        if (session.audioBuffer.length > SILENCE_FRAMES) session.audioBuffer.shift();
    }
}

async function handleSpeechEnd(audioData) {
    if (!session) return;
    sendToRenderer('update-status', 'Transcribing...');
    const text = await transcription.transcribeAudio(audioData, sendToRenderer);
    if (!text || transcription.isNoiseTranscription(text)) {
        sendToRenderer('update-status', 'Listening...');
        return;
    }
    pendingTranscription = text;
    drainGenerations();
}

async function drainGenerations() {
    if (isGenerating || !pendingTranscription || !session) return;
    isGenerating = true;
    while (pendingTranscription && session) {
        const text = pendingTranscription;
        pendingTranscription = null;
        sendToRenderer('update-status', 'Generating response...');
        await sendToChatGPT(text);
    }
    isGenerating = false;
    if (session) sendToRenderer('update-status', 'Listening...');
}
```

- [ ] **Step 4: `sendToChatGPT` (SSE) — the core inference call.**

```javascript
function buildHeaders(auth, sessionId) {
    return {
        'Authorization': `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId || '',
        'OpenAI-Beta': 'responses=experimental',
        'originator': ORIGINATOR,
        'session_id': sessionId,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    };
}

function buildBody(model, instructions, content) {
    return JSON.stringify({
        model,
        instructions,
        input: [{ type: 'message', role: 'user', content }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
        include: [],
    });
}

async function streamResponses(content, retryOn401 = true) {
    const auth = await ensureValidOpenAIAuth();
    if (!auth || !auth.accessToken) {
        sendToRenderer('update-status', 'ChatGPT account not connected');
        return;
    }
    const resp = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: buildHeaders(auth, session.sessionId),
        body: buildBody(session.model, session.systemPrompt, content),
    });

    if (resp.status === 401 && retryOn401) {
        const refreshed = await require('./openaiOAuth').refreshOpenAIAuth(auth).catch(() => null);
        if (refreshed) return streamResponses(content, false);
    }
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        sendToRenderer('update-status', `ChatGPT error ${resp.status}: ${errText.slice(0, 200)}`);
        return;
    }

    // Parse Responses API SSE: events carry JSON with type/delta.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let isFirst = true;

    const flushEvent = dataStr => {
        if (!dataStr || dataStr === '[DONE]') return;
        let evt;
        try { evt = JSON.parse(dataStr); } catch { return; }
        // delta text events
        if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            fullText += evt.delta;
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
            isFirst = false;
        } else if (evt.type === 'response.completed' || evt.type === 'response.output_text.done') {
            if (fullText) sendToRenderer('update-response', fullText);
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) flushEvent(trimmed.slice(5).trim());
        }
    }
    if (fullText) saveConversationTurn?.(content.map(c => c.text || '[image]').join(' '), fullText);
}

async function sendToChatGPT(text) {
    if (!session) return;
    const content = [{ type: 'input_text', text }];
    if (latestScreenshot) {
        content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${latestScreenshot}` });
    }
    try {
        await streamResponses(content);
    } catch (error) {
        sendToRenderer('update-status', 'ChatGPT error: ' + error.message);
    }
}
```

> The SSE event type names (`response.output_text.delta`, `response.completed`) follow the OpenAI Responses API streaming spec. Task 9 validates the actual event names from the codex backend and adjusts `flushEvent` if they differ.

- [ ] **Step 5: `sendChatGPTImage`, `closeChatGPTSession`, exports.**

```javascript
async function sendChatGPTImage(base64Data, prompt = '') {
    if (!session) return;
    latestScreenshot = base64Data;
    const content = [
        { type: 'input_text', text: prompt || 'Analyze the screen and help based on the current conversation.' },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${base64Data}` },
    ];
    sendToRenderer('update-status', 'Analyzing image...');
    try {
        await streamResponses(content);
    } catch (error) {
        sendToRenderer('update-status', 'ChatGPT error: ' + error.message);
    }
    if (session) sendToRenderer('update-status', 'Listening...');
}

async function sendChatGPTText(text) {
    if (!session) return;
    pendingTranscription = text;
    return drainGenerations();
}

function closeChatGPTSession() {
    session = null;
    latestScreenshot = null;
    isGenerating = false;
    pendingTranscription = null;
}

module.exports = {
    initializeChatGPTSession,
    processChatGPTAudio,
    sendChatGPTText,
    sendChatGPTImage,
    closeChatGPTSession,
    isChatGPTSessionActive,
    setLatestScreenshot,
};
```

- [ ] **Step 6: Load-check the module.**

Run: `node -e "require('./src/utils/chatgptai.js'); console.log('chatgptai loads')"`
Expected: `chatgptai loads`

- [ ] **Step 7: Commit.**

```bash
git add src/utils/chatgptai.js
git commit -m "feat(chatgpt): add ChatGPT subscription inference provider"
```

---

## Task 6: Main-process wiring (`index.js`)

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Import the chatgpt provider** near the top of `index.js`.

```javascript
const chatgptai = require('./utils/chatgptai');
```

- [ ] **Step 2: Add `initialize-chatgpt` IPC** (mirror the `initialize-local` handler).

```javascript
    ipcMain.handle('initialize-chatgpt', async (event, profile, customPrompt, language, model) => {
        return chatgptai.initializeChatGPTSession(profile, customPrompt, language, model);
    });
```

- [ ] **Step 3: Route audio/image/close to chatgpt when its session is active.**

Find where `initialize-local` audio/image handlers route to `localai` (search `localai.processLocalAudio`, `localai.sendLocalImage`, `localai.closeLocalSession`, `localai.isLocalSessionActive`). At each routing point add a chatgpt branch first, e.g.:

```javascript
        if (chatgptai.isChatGPTSessionActive()) {
            chatgptai.processChatGPTAudio(monoChunk);
            return;
        }
```

Apply the same pattern for the screenshot handler (`chatgptai.setLatestScreenshot(...)` and/or `chatgptai.sendChatGPTImage(...)`), the manual-text handler (`chatgptai.sendChatGPTText(...)`), and the session-close handler (`chatgptai.closeChatGPTSession()`).

- [ ] **Step 4: Load-check.**

Run: `node -e "require('./src/index.js')" 2>&1 | head -5` — expect it to fail only on Electron `app` APIs, not on require/syntax of the new code. (A clean syntax error in our additions must not appear.)

- [ ] **Step 5: Commit.**

```bash
git add src/index.js
git commit -m "feat(chatgpt): wire chatgpt provider IPC and audio/image routing"
```

---

## Task 7: Renderer wiring (`renderer.js`)

**Files:**
- Modify: `src/utils/renderer.js`

- [ ] **Step 1: Add `initializeChatGPT`** (mirror `initializeLocal` at `renderer.js:188`).

```javascript
async function initializeChatGPT(profile = 'interview') {
    const prefs = await ipcRenderer.invoke('storage:get-preferences');
    const customPrompt = prefs.customPrompt || '';
    const language = prefs.selectedLanguage || 'en-US';
    const model = prefs.chatgptModel || 'gpt-5';
    return ipcRenderer.invoke('initialize-chatgpt', profile, customPrompt, language, model);
}
```

- [ ] **Step 2: Export it** in the `module.exports` block (next to `initializeLocal`).

```javascript
    initializeChatGPT,
```

- [ ] **Step 3: Ensure capture (audio frames + screenshots) is sent through the same IPC channels** the local provider uses — no change needed if capture is provider-agnostic (it sends to fixed channels; main routes by active session). Verify by reading the capture send sites; if a channel is gated on `providerMode==='local'`, add `|| providerMode==='chatgpt'`.

- [ ] **Step 4: Commit.**

```bash
git add src/utils/renderer.js
git commit -m "feat(chatgpt): renderer initializeChatGPT + capture routing"
```

---

## Task 8: UI integration

**Files:**
- Modify: `src/components/views/MainView.js`
- Modify: `src/components/app/CheatingDaddyApp.js`
- Modify: `src/components/views/CustomizeView.js`

- [ ] **Step 1: `MainView.js` — add provider option.** Find the provider-mode selector (search `providerMode` / the `byok`/`local` buttons around `MainView.js:541`). Add a "ChatGPT (subscription)" option whose handler calls `updatePreference('providerMode', 'chatgpt')`, matching the existing option markup.

- [ ] **Step 2: `CheatingDaddyApp.js handleStart` — add the `chatgpt` branch.** After the `local` branch (`CheatingDaddyApp.js:589-597`), before the final `else`:

```javascript
        } else if (providerMode === 'chatgpt') {
            const status = await cheatingDaddy.oauth.getOpenAIStatus();
            if (!status || !status.connected) {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) mainView.triggerApiKeyError();
                this.currentView = 'customize';
                return;
            }
            const success = await cheatingDaddy.initializeChatGPT(this.selectedProfile);
            if (!success) {
                const mainView = this.shadowRoot.querySelector('main-view');
                if (mainView && mainView.triggerApiKeyError) mainView.triggerApiKeyError();
                return;
            }
```

> Confirm `cheatingDaddy.oauth.getOpenAIStatus()` returns `{ connected }` (it wraps IPC `oauth:get-openai-status` → `{ success, data }`). If it returns `{ data: { connected } }`, read `status.data.connected`. Check `renderer.js:129`.

- [ ] **Step 3: `CustomizeView.js` — remove the client_id input field.** Find the OpenAI OAuth settings section (around `CustomizeView.js:299-349` for handlers and `:904-909` for markup). Remove the client-id text input and any `openaiOauthClientId` read/write. Keep the Connect/Disconnect buttons and status display. Update `_connectOpenAI` to call `cheatingDaddy.oauth.connectOpenAI()` with no client-id argument.

- [ ] **Step 4: Run OAuth tests + module load checks.**

Run: `node scripts/test-openai-oauth.js && node -e "require('./src/utils/chatgptai.js'); console.log('ok')"`
Expected: tests pass + `ok`.

- [ ] **Step 5: Commit.**

```bash
git add src/components/views/MainView.js src/components/app/CheatingDaddyApp.js src/components/views/CustomizeView.js
git commit -m "feat(chatgpt): UI provider option, start gate, simplified connect"
```

---

## Task 9: Manual smoke test + payload/event validation

**Files:** none (validation), then small follow-up edits to `chatgptai.js` if needed.

- [ ] **Step 1: Install + run.**

Run: `npm install && npm start`
Expected: app launches.

- [ ] **Step 2: Connect account.** In Customize, click Connect → browser OAuth → status shows connected with email/account. Verify `credentials.json` stores encrypted `openaiOAuth` with `accountId`.

- [ ] **Step 3: Start a `chatgpt` session and speak.** Confirm transcription → a streamed response appears in the overlay.

- [ ] **Step 4: If the backend rejects the request**, capture the error shown in status and adjust in `chatgptai.js`:
  - 400 about model → try `session.model = 'gpt-5-codex'` (set pref `chatgptModel`).
  - 400 about payload shape → align `buildBody` fields to the error (e.g. add/remove `tools`, `reasoning`, `prompt_cache_key`).
  - SSE produces no text → log raw `data:` lines and correct event names in `flushEvent`.
  - 401 persists after refresh → re-check `chatgpt-account-id` header and that `accessToken` (not exchanged api-key) is used.

- [ ] **Step 5: Screenshot turn.** Trigger a manual screen analysis; confirm the image is included and influences the answer.

- [ ] **Step 6: Commit any adjustments.**

```bash
git add src/utils/chatgptai.js
git commit -m "fix(chatgpt): align responses payload/SSE with live backend"
```

---

## Self-review notes

- **Spec coverage:** OAuth rewrite (T1), tests (T2), storage/IPC cleanup (T3), shared transcription (T4), provider (T5), main wiring (T6), renderer (T7), UI (T8), error handling (T5 401/retry + status), manual verification (T9). All spec criteria mapped.
- **Type consistency:** `session.model`/`session.sessionId`/`session.systemPrompt` used consistently; provider exports (`initializeChatGPTSession`, `processChatGPTAudio`, `sendChatGPTText`, `sendChatGPTImage`, `closeChatGPTSession`, `isChatGPTSessionActive`, `setLatestScreenshot`) referenced identically in T6/T7.
- **Known runtime-validated unknowns (T9):** exact `OpenAI-Beta` value, accepted model slug, Responses SSE event names, full payload fidelity. These are isolated to `buildBody`/`buildHeaders`/`flushEvent` and the `chatgptModel` pref.
