const crypto = require('crypto');
const { sendToRenderer, initializeNewSession, saveConversationTurn, saveScreenAnalysis } = require('./gemini');
const { getSystemPrompt } = require('./prompts');
const transcription = require('./transcription');
const { createAudioMixer } = require('./audioMixer');
const realtime = require('./realtimeTranscription');
const groq = require('./groqTranscription');
const { ensureValidOpenAIAuth, refreshOpenAIAuth } = require('./openaiOAuth');
const storage = require('../storage');

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';

// VAD constants. Кадр микшера — 100 мс, поэтому N кадров тишины = N * 100 мс.
const SILENCE_RMS = 0.01;
const FRAME_MS = 100;
const DEFAULT_SILENCE_FRAMES = 8; // 0.8 с — настраивается через chatgptSilenceMs
// Короткий всплеск громкости (щелчок, стук по столу) не должен считаться репликой и запускать ответ
const MIN_SPEECH_FRAMES = 3; // 0.3 с реальной речи
const DEFAULT_HISTORY_MESSAGES = 10; // keep last N turns (user+assistant) as conversation context

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

function languageDirective(locale) {
    if (!locale || locale === 'en-US') {
        return '';
    }
    return `\n\nRespond in ${locale}.`;
}

async function initializeChatGPTSession(profile = 'interview', customPrompt = '', language = 'ru-RU', model = 'gpt-5.4-mini') {
    sendToRenderer('session-initializing', true);
    try {
        const auth = await ensureValidOpenAIAuth();
        if (!auth || !auth.accessToken) {
            sendToRenderer('session-initializing', false);
            sendToRenderer('update-status', 'ChatGPT account not connected');
            return false;
        }

        const prefs = storage.getPreferences();
        const sttEngine = prefs.chatgptTranscription || 'local'; // 'local' | 'groq' | 'realtime'
        const wantRealtime = sttEngine === 'realtime';

        const systemPrompt = getSystemPrompt(profile, customPrompt, false) + languageDirective(language);
        session = {
            systemPrompt,
            model,
            sessionId: crypto.randomUUID(),
            audioBuffer: [],
            speechFrames: 0,
            silenceCount: 0,
            isSpeaking: false,
            sttEngine,
            langCode: (language || 'en-US').split('-')[0],
            useRealtime: wantRealtime,
            reasoningEffort: prefs.chatgptReasoningEffort || 'medium',
            history: [], // [{ role: 'user' | 'assistant', text }] — conversation context for follow-ups
            silenceFrames: Math.max(1, Math.round((prefs.chatgptSilenceMs ?? DEFAULT_SILENCE_FRAMES * FRAME_MS) / FRAME_MS)),
            historyLimit: prefs.chatgptHistoryTurns ?? DEFAULT_HISTORY_MESSAGES,
            lastRequest: null, // последний запрос — для повторной генерации
            mixer: null,
        };
        const audioMode = prefs.audioMode || 'speaker_only';
        session.mixer = createAudioMixer(processMixedFrame, {
            expectMic: audioMode === 'mic_only' || audioMode === 'both',
            expectSystem: audioMode !== 'mic_only',
        });
        isGenerating = false;
        pendingTranscription = null;
        initializeNewSession(profile, customPrompt);

        transcription.resetResampleState();
        // Load Whisper unless transcription is fully cloud (Groq) — keep it for local/realtime-fallback.
        if (sttEngine !== 'groq') {
            transcription.setTranscribeLanguage(language);
            // Deliberately not `whisperModel` — that one belongs to the native local mode and is set independently
            const whisperModel = prefs.chatgptWhisperModel || 'base';
            await transcription.loadWhisperPipeline(whisperModel, sendToRenderer, prefs.speechDetectorEnabled !== false);
        }

        if (wantRealtime) {
            realtime
                .startRealtimeTranscription({
                    onTranscript: text => {
                        if (!session) return;
                        pendingTranscription = text;
                        drainGenerations();
                    },
                    onError: () => {
                        if (session) session.useRealtime = false;
                        sendToRenderer('update-status', 'Realtime unavailable — using local Whisper. Listening...');
                    },
                })
                .catch(error => {
                    if (session) session.useRealtime = false;
                    console.error('[Realtime] start failed:', error.message);
                });
        }

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

/**
 * @param {Buffer} monoChunk24k кусок PCM16 24 кГц
 * @param {'system'|'mic'} source микрофон и системный звук приходят разными IPC-каналами
 */
function processChatGPTAudio(monoChunk24k, source = 'system') {
    if (!session) {
        return;
    }
    // Realtime path: forward raw 24kHz PCM straight to the cloud transcription socket (no local VAD).
    if (session.useRealtime && realtime.isRealtimeReady()) {
        realtime.appendAudio(monoChunk24k);
        return;
    }
    if (!session.mixer) {
        return;
    }
    // Сведение двух источников идёт до VAD: иначе они чередуются кусками и рвут фразы
    if (source === 'mic') {
        session.mixer.pushMic(monoChunk24k);
    } else {
        session.mixer.pushSystem(monoChunk24k);
    }
}

function processMixedFrame(pcm16k) {
    if (!session) return;
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
        if (session.silenceCount >= session.silenceFrames) {
            // Считанного всплеска слишком мало для реплики — это шум, ждём дальше, а не запускаем ответ
            if (session.speechFrames < MIN_SPEECH_FRAMES) {
                session.isSpeaking = false;
                session.silenceCount = 0;
                session.speechFrames = 0;
                session.audioBuffer = [];
                return;
            }

            const audio = Buffer.concat(session.audioBuffer);
            session.audioBuffer = [];
            session.isSpeaking = false;
            session.silenceCount = 0;
            session.speechFrames = 0;
            handleSpeechEnd(audio);
        }
    } else if (session.audioBuffer.length > session.silenceFrames) {
        session.audioBuffer.shift();
    }
}

async function handleSpeechEnd(audioData) {
    if (!session) {
        return;
    }
    sendToRenderer('update-status', 'Transcribing...');
    let text;
    try {
        if (session.sttEngine === 'groq') {
            text = await groq.transcribeWithGroq(audioData, session.langCode);
        } else {
            text = await transcription.transcribeAudio(audioData, sendToRenderer);
        }
    } catch (error) {
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
        return;
    }
    if (!text || transcription.isNoiseTranscription(text)) {
        sendToRenderer('update-status', 'Listening...');
        return;
    }
    pendingTranscription = text;
    drainGenerations();
}

async function drainGenerations() {
    if (isGenerating || !pendingTranscription || !session) {
        return;
    }
    isGenerating = true;
    while (pendingTranscription && session) {
        const text = pendingTranscription;
        pendingTranscription = null;
        sendToRenderer('update-status', 'Generating response...');
        await sendToChatGPT(text);
    }
    isGenerating = false;
    if (session) {
        sendToRenderer('update-status', 'Listening...');
    }
}

function buildHeaders(auth, sessionId) {
    return {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId || '',
        'OpenAI-Beta': 'responses=experimental',
        originator: ORIGINATOR,
        session_id: sessionId,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
    };
}

function historyToInput(history) {
    return history.map(turn => ({
        type: 'message',
        role: turn.role,
        content: [{ type: turn.role === 'assistant' ? 'output_text' : 'input_text', text: turn.text }],
    }));
}

function buildBody(model, instructions, content, history = [], reasoningEffort = '') {
    const payload = {
        model,
        instructions,
        input: [...historyToInput(history), { type: 'message', role: 'user', content }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
        include: [],
    };
    if (reasoningEffort && reasoningEffort !== 'none') {
        payload.reasoning = { effort: reasoningEffort };
    }
    return JSON.stringify(payload);
}

async function streamResponses(content, retryOn401 = true) {
    const auth = await ensureValidOpenAIAuth();
    if (!auth || !auth.accessToken) {
        sendToRenderer('update-status', 'ChatGPT account not connected');
        return;
    }
    if (!session) {
        return;
    }

    const resp = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: buildHeaders(auth, session.sessionId),
        body: buildBody(session.model, session.systemPrompt, content, session.history, session.reasoningEffort),
    });

    if (resp.status === 401 && retryOn401) {
        const refreshed = await refreshOpenAIAuth(auth).catch(() => null);
        if (refreshed) {
            return streamResponses(content, false);
        }
    }
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[ChatGPT] error ${resp.status} body:`, errText.slice(0, 1000));
        sendToRenderer('update-status', `ChatGPT error ${resp.status}: ${errText.slice(0, 200)}`);
        return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let isFirst = true;

    const flushEvent = dataStr => {
        if (!dataStr || dataStr === '[DONE]') {
            return;
        }
        let evt;
        try {
            evt = JSON.parse(dataStr);
        } catch {
            return;
        }
        if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
            fullText += evt.delta;
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
            isFirst = false;
        } else if (evt.type === 'response.completed' || evt.type === 'response.output_text.done') {
            if (fullText) {
                sendToRenderer('update-response', fullText);
            }
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
                flushEvent(trimmed.slice(5).trim());
            }
        }
    }

    if (fullText) {
        const promptText = content.map(c => c.text || '[image]').join(' ');
        const imagePart = content.find(part => part.type === 'input_image');

        if (imagePart) {
            // Скриншоты идут во вкладку Screen вместе с кадром: в ленте беседы они выглядели
            // как реплика пользователя с текстом служебного промпта
            const base64 = String(imagePart.image_url || '').replace(/^data:image\/\w+;base64,/, '');
            saveScreenAnalysis(promptText, fullText, session?.model || 'chatgpt', base64);
        } else {
            saveConversationTurn(promptText, fullText);
        }

        if (session) {
            // Запоминаем запрос целиком (вместе с картинкой), чтобы можно было переспросить
            session.lastRequest = content;
            session.history.push({ role: 'user', text: promptText }, { role: 'assistant', text: fullText });
            if (session.history.length > session.historyLimit) {
                session.history = session.history.slice(-session.historyLimit);
            }
        }
    }
}

async function sendToChatGPT(text) {
    if (!session) {
        return;
    }
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

async function sendChatGPTImage(base64Data, prompt = '') {
    if (!session) {
        return;
    }
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
    if (session) {
        sendToRenderer('update-status', 'Listening...');
    }
}

async function sendChatGPTText(text) {
    if (!session) {
        return;
    }
    pendingTranscription = text;
    return drainGenerations();
}

/**
 * Просит модель ответить заново на тот же вопрос.
 *
 * Предыдущую пару «вопрос-ответ» убираем из истории, иначе модель увидит свой прошлый
 * ответ как данность и лишь перескажет его.
 */
async function regenerateLastAnswer() {
    if (!session || !session.lastRequest) {
        sendToRenderer('update-status', 'Nothing to regenerate yet');
        return false;
    }
    if (isGenerating) {
        sendToRenderer('update-status', 'Still answering — try again in a moment');
        return false;
    }

    if (session.history.length >= 2) {
        session.history = session.history.slice(0, -2);
    }

    isGenerating = true;
    sendToRenderer('update-status', 'Regenerating...');
    try {
        await streamResponses(session.lastRequest);
    } catch (error) {
        sendToRenderer('update-status', 'ChatGPT error: ' + error.message);
        return false;
    } finally {
        isGenerating = false;
    }
    if (session) {
        sendToRenderer('update-status', 'Listening...');
    }
    return true;
}

/**
 * Разовый запрос к ChatGPT вне активной сессии — для итогов беседы.
 *
 * Работает по той же подписке, но не трогает историю диалога и не стримит в оверлей:
 * итоги нужны после разговора, когда сессия уже закрыта.
 */
async function askOneShot(instructions, userText, { model = 'gpt-5.4-mini', reasoningEffort = 'low' } = {}) {
    const auth = await ensureValidOpenAIAuth();
    if (!auth || !auth.accessToken) {
        throw new Error('ChatGPT account not connected');
    }

    const response = await fetch(RESPONSES_URL, {
        method: 'POST',
        headers: buildHeaders(auth, crypto.randomUUID()),
        body: buildBody(model, instructions, [{ type: 'input_text', text: userText }], [], reasoningEffort),
    });

    if (!response.ok) {
        const details = await response.text().catch(() => '');
        throw new Error(`ChatGPT error ${response.status}: ${details.slice(0, 200)}`);
    }

    // Ответ приходит потоком SSE даже для разового запроса — собираем целиком
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            try {
                const event = JSON.parse(trimmed.slice(5).trim());
                if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
                    fullText += event.delta;
                }
            } catch {
                // не JSON — пропускаем
            }
        }
    }

    return fullText.trim();
}

function closeChatGPTSession() {
    session?.mixer?.flush();
    realtime.stopRealtimeTranscription();
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
    regenerateLastAnswer,
    askOneShot,
    closeChatGPTSession,
    isChatGPTSessionActive,
    setLatestScreenshot,
};
