const fs = require('fs');
const path = require('path');
const { getSystemPrompt } = require('./prompts');
const { sendToRenderer, initializeNewSession, saveConversationTurn } = require('./gemini');
const {
    ensureNativeBinary,
    ensureLlamaModel,
    getAvailablePort,
    getModelsDirectory,
    startNativeServer,
    stopNativeServer,
    waitForServer,
} = require('./native-ai-runtime');
// Распознавание вынесено в общий сервис: тот же whisper-server использует и режим ChatGPT
const whisper = require('./whisperService');
const { createAudioMixer } = require('./audioMixer');

// Сводит микрофон и системный звук перед VAD; создаётся на сессию под её audioMode
let audioMixer = null;

let llamaProcess = null;
let llamaBaseUrl = null;
let llamaModel = null;
// Проектор зрения опционален: без него модель отвечает только по тексту
let visionAvailable = false;
// Последняя реплика пользователя — для повторной генерации
let lastUserRequest = null;
let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;
let initializationController = null;
let llamaCacheSnapshot = new Set();
// Most recent screen frame (automated capture), attached to the next voice answer so the model can "see" the screen
let latestScreenshot = null;

let isSpeaking = false;
let speechBuffers = [];
let silenceFrameCount = 0;
let speechFrameCount = 0;

const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};

let vadConfig = VAD_MODES.VERY_AGGRESSIVE;

// Ресемплинг 24→16 кГц переехал в audioMixer: у каждого источника звука он свой,
// иначе микрофон и колонки портят друг другу остаток между вызовами.

function calculateRms(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / samples);
}

function processVad(pcm16kBuffer) {
    const rms = calculateRms(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount += 1;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount += 1;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            const audioData = Buffer.concat(speechBuffers);
            speechBuffers = [];
            console.log('[LocalAI] Speech ended, accumulated', audioData.length, 'bytes');
            sendToRenderer('update-status', 'Transcribing...');
            handleSpeechEnd(audioData);
            return;
        }
    }

    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
    }
}

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    try {
        const transcription = await whisper.transcribePcm(audioData);

        if (!transcription || transcription.length < 2) {
            console.log('[LocalAI] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        sendToRenderer('update-status', 'Generating response...');
        await sendToLlama(transcription);
    } catch (error) {
        console.error('[LocalAI] Transcription error:', error);
        sendToRenderer('update-status', 'Transcription error: ' + error.message);
    }
}

async function readStreamingResponse(response, onText) {
    const decoder = new TextDecoder();
    let pendingText = '';
    let fullText = '';

    for await (const chunk of response.body) {
        pendingText += decoder.decode(chunk, { stream: true });
        const lines = pendingText.split('\n');
        pendingText = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;

            const event = JSON.parse(data);
            const token = event.choices?.[0]?.delta?.content || '';
            if (!token) continue;

            fullText += token;
            onText(fullText);
        }
    }

    return fullText;
}

async function requestLlama(messages, onText) {
    if (!llamaBaseUrl) {
        throw new Error('Llama server is not running');
    }

    const response = await fetch(`${llamaBaseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'local',
            messages,
            stream: true,
            max_tokens: 2048,
            chat_template_kwargs: {
                enable_thinking: false,
            },
        }),
    });

    if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(`Llama server returned HTTP ${response.status}: ${errorText}`);
    }

    return readStreamingResponse(response, onText);
}

async function sendToLlama(transcription) {
    // Запоминаем реплику, чтобы можно было переспросить по ней же
    lastUserRequest = transcription.trim();
    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    // Attach the most recent automated frame once, so the model can "see" the screen for this answer
    const screenshot = latestScreenshot;
    latestScreenshot = null;

    try {
        const historyMessages = screenshot
            ? [
                  ...localConversationHistory.slice(0, -1),
                  {
                      role: 'user',
                      content: [
                          { type: 'text', text: transcription.trim() },
                          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshot}` } },
                      ],
                  },
              ]
            : localConversationHistory;
        const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...historyMessages];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });
            saveConversationTurn(transcription, fullText);
        }

        console.log('[LocalAI] Llama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Llama error:', error);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        throw error;
    }
}

function formatDownloadStatus(label, progress) {
    if (!progress.expectedBytes) {
        return `Downloading ${label}...`;
    }

    const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
    return `Downloading ${label}... ${percentage}%`;
}

function sendDownloadProgress(label, progress = null) {
    const percentage = progress?.expectedBytes ? Math.min(100, Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100)) : null;
    sendToRenderer('local-ai-download-progress', {
        active: true,
        label,
        percentage,
    });
}

function getDirectoryEntries(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return new Set();
    }

    const entries = new Set();
    const visit = currentPath => {
        for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
            const entryPath = path.join(currentPath, entry.name);
            entries.add(entryPath);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
        }
    };

    visit(directoryPath);
    return entries;
}

function removeNewLlamaCacheEntries() {
    const cacheDirectory = path.join(getModelsDirectory(), 'llama');
    const currentEntries = Array.from(getDirectoryEntries(cacheDirectory));
    currentEntries.sort((first, second) => second.length - first.length);

    for (const entryPath of currentEntries) {
        if (!llamaCacheSnapshot.has(entryPath)) {
            fs.rmSync(entryPath, { recursive: true, force: true });
        }
    }
}

async function prepareNativeFiles(llamaModelReference, signal, withVision = true) {
    const binaryProgress = label => progress => {
        sendToRenderer('update-status', formatDownloadStatus(label, progress));
        sendDownloadProgress(label, progress);
    };

    sendDownloadProgress('Checking Llama runner');
    const llamaBinaryPath = await ensureNativeBinary('llama', binaryProgress('Llama runner'), signal);

    sendDownloadProgress('Checking language model');
    const llamaFiles = await ensureLlamaModel(
        llamaModelReference,
        binaryProgress('Language model'),
        binaryProgress('Vision model'),
        signal,
        withVision
    );
    return {
        llamaBinaryPath,
        llamaModelPath: llamaFiles.modelPath,
        projectorPath: llamaFiles.projectorPath,
    };
}

function validatePreparedNativeFiles(nativeFiles) {
    const requiredFiles = [
        ['Llama runner', nativeFiles.llamaBinaryPath],
        ['Language model', nativeFiles.llamaModelPath],
    ];

    for (const [label, filePath] of requiredFiles) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} path is invalid: ${filePath}`);
        }
    }

    // Проектор нужен только для зрения: без него сессия просто теряет разбор скриншотов
    if (nativeFiles.projectorPath && !fs.existsSync(nativeFiles.projectorPath)) {
        throw new Error(`Vision model path is invalid: ${nativeFiles.projectorPath}`);
    }
}

async function startLlamaServer(executablePath, modelPath, projectorPath) {
    if (!modelPath || !fs.existsSync(modelPath)) {
        throw new Error(`Language model path is invalid: ${modelPath}`);
    }

    const port = await getAvailablePort();
    const argumentsList = ['--host', '127.0.0.1', '--port', String(port), '--alias', 'local', '-c', '8192', '-m', modelPath];

    // Без проектора модель работает как текстовая — скриншоты просто не разбираются
    if (projectorPath && fs.existsSync(projectorPath)) {
        argumentsList.push('--mmproj', projectorPath);
        visionAvailable = true;
    } else {
        visionAvailable = false;
        console.log('[LocalAI] Проектор зрения не загружен — режим только текста');
    }

    if (process.platform === 'darwin') {
        argumentsList.push('-ngl', '99');
    }

    llamaBaseUrl = `http://127.0.0.1:${port}`;
    llamaProcess = startNativeServer({
        executablePath,
        arguments: argumentsList,
        name: 'Llama',
    });

    await waitForServer(`${llamaBaseUrl}/health`, llamaProcess, 30 * 60 * 1000);
}

async function initializeLocalSession(model, whisperModel, profile, customPrompt, language = 'en-US', withVision = true, audioMode = 'speaker_only') {
    console.log('[LocalAI] Initializing native local session:', { model, whisperModel, language, profile });
    sendToRenderer('session-initializing', true);

    try {
        closeLocalSession();
        initializationController = new AbortController();
        llamaCacheSnapshot = getDirectoryEntries(path.join(getModelsDirectory(), 'llama'));
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        llamaModel = model;

        const nativeFiles = await prepareNativeFiles(model, initializationController.signal, withVision);
        validatePreparedNativeFiles(nativeFiles);

        sendToRenderer('update-status', 'Starting Whisper...');
        sendDownloadProgress('Starting Whisper');
        await whisper.startWhisper({
            model: whisperModel,
            language,
            useVad: require('../storage').getPreferences().speechDetectorEnabled !== false,
            sendToRenderer,
            onProgress: (label, progress) => {
                sendToRenderer('update-status', formatDownloadStatus(label, progress));
                sendDownloadProgress(label, progress);
            },
            signal: initializationController.signal,
        });

        sendToRenderer('update-status', 'Loading local language model...');
        sendDownloadProgress('Loading language model');
        await startLlamaServer(nativeFiles.llamaBinaryPath, nativeFiles.llamaModelPath, nativeFiles.projectorPath);

        isSpeaking = false;
        speechBuffers = [];
        silenceFrameCount = 0;
        speechFrameCount = 0;
        localConversationHistory = [];
        latestScreenshot = null;
        // Микшер должен знать, каких источников ждать, иначе будет простаивать в ожидании выключенного
        audioMixer = createAudioMixer(processVad, {
            expectMic: audioMode === 'mic_only' || audioMode === 'both',
            expectSystem: audioMode !== 'mic_only',
        });

        initializeNewSession(profile, customPrompt);
        isLocalActive = true;
        initializationController = null;
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');
        console.log('[LocalAI] Native session initialized successfully');
        return true;
    } catch (error) {
        const wasCancelled = error.name === 'AbortError' || initializationController?.signal.aborted;
        if (wasCancelled) {
            console.log('[LocalAI] Initialization cancelled');
        } else {
            console.error('[LocalAI] Initialization error:', error);
        }
        closeLocalSession();
        if (wasCancelled) {
            removeNewLlamaCacheEntries();
        }
        sendToRenderer('local-ai-download-progress', { active: false });
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', wasCancelled ? 'Local AI download cancelled' : 'Local AI error: ' + error.message);
        return false;
    }
}

/**
 * @param {Buffer} monoChunk24k кусок PCM16 24 кГц
 * @param {'system'|'mic'} source откуда пришёл звук — микрофон и колонки идут разными IPC-каналами
 */
function processLocalAudio(monoChunk24k, source = 'system') {
    if (!isLocalActive || !audioMixer) return;

    if (source === 'mic') {
        audioMixer.pushMic(monoChunk24k);
    } else {
        audioMixer.pushSystem(monoChunk24k);
    }
}

function closeLocalSession() {
    // Хвост записи мог остаться в очереди микшера — выпускаем его до остановки
    audioMixer?.flush();
    isLocalActive = false;
    initializationController?.abort();
    initializationController = null;
    stopNativeServer(llamaProcess);
    whisper.stopWhisper();
    llamaProcess = null;
    llamaBaseUrl = null;
    llamaModel = null;
    visionAvailable = false;
    lastUserRequest = null;
    audioMixer = null;
    isSpeaking = false;
    speechBuffers = [];
    silenceFrameCount = 0;
    speechFrameCount = 0;
    localConversationHistory = [];
    currentSystemPrompt = null;
    latestScreenshot = null;
}

/** Отвечает заново на ту же реплику: прошлую пару убираем, иначе модель перескажет свой ответ. */
async function regenerateLastAnswer() {
    if (!isLocalActive || !lastUserRequest) {
        sendToRenderer('update-status', 'Nothing to regenerate yet');
        return false;
    }

    // убираем предыдущие user+assistant
    localConversationHistory = localConversationHistory.slice(0, -2);
    sendToRenderer('update-status', 'Regenerating...');
    try {
        await sendToLlama(lastUserRequest);
        return true;
    } catch (error) {
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        return false;
    }
}

function setLatestScreenshot(base64Data) {
    // Без проектора кадр приложить некуда — не копим его в памяти
    latestScreenshot = visionAvailable ? base64Data : null;
}

async function cancelLocalInitialization() {
    if (!initializationController) {
        return false;
    }

    initializationController.abort();
    stopNativeServer(llamaProcess);
    whisper.stopWhisper();
    await new Promise(resolve => setTimeout(resolve, 300));
    removeNewLlamaCacheEntries();
    sendToRenderer('local-ai-download-progress', { active: false });
    sendToRenderer('session-initializing', false);
    return true;
}

function isLocalSessionActive() {
    return isLocalActive;
}

async function sendLocalText(text) {
    if (!isLocalActive || !llamaProcess) {
        return { success: false, error: 'No active local session' };
    }

    try {
        await sendToLlama(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive || !llamaProcess) {
        return { success: false, error: 'No active local session' };
    }
    if (!visionAvailable) {
        // Молча отправить картинку в текстовую модель нельзя: она ответит выдумкой
        return { success: false, error: 'Vision is disabled — enable it in Local AI settings to analyse screenshots' };
    }

    const userMessage = {
        role: 'user',
        content: [
            { type: 'text', text: prompt },
            {
                type: 'image_url',
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`,
                },
            },
        ],
    };

    localConversationHistory.push({ role: 'user', content: prompt });
    if (localConversationHistory.length > 20) {
        localConversationHistory = localConversationHistory.slice(-20);
    }

    try {
        sendToRenderer('update-status', 'Analyzing image...');
        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            userMessage,
        ];

        let isFirst = true;
        const fullText = await requestLlama(messages, text => {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', text);
            isFirst = false;
        });

        if (fullText.trim()) {
            localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: llamaModel };
    } catch (error) {
        console.error('[LocalAI] Image error:', error);
        sendToRenderer('update-status', 'Local AI image error: ' + error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeLocalSession,
    cancelLocalInitialization,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
    setLatestScreenshot,
    regenerateLastAnswer,
};
