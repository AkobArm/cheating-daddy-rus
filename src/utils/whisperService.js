// ── Общий сервис распознавания речи на whisper.cpp ──
//
// Один whisper-server на всё приложение: им пользуются и local-режим (localai.js),
// и режим ChatGPT (chatgptai.js). Раньше ChatGPT-режим гонял Whisper через
// transformers.js/onnxruntime на CPU — на том же аудио это было примерно вчетверо
// медленнее, а загрузка модели занимала ~19 секунд против ~0.3 здесь.
//
// Модуль НЕ должен требовать ./gemini, ./localai или ./chatgptai (циклы зависимостей):
// всё общение с рендерером идёт через переданный колбэк sendToRenderer.

const {
    ensureNativeBinary,
    ensureWhisperModel,
    ensureVadModel,
    getAvailablePort,
    startNativeServer,
    stopNativeServer,
    waitForServer,
    resolveWhisperModelForLanguage,
} = require('./native-ai-runtime');

let whisperProcess = null;
let whisperBaseUrl = null;
let whisperLanguage = 'en';
let activeModel = null;
let activeVad = null;
let startPromise = null;

function isWhisperRunning() {
    return whisperProcess !== null && whisperBaseUrl !== null;
}

function getWhisperLanguage() {
    return whisperLanguage;
}

/** 'ru-RU' → 'ru': whisper ждёт двухбуквенный код, а не локаль. */
function setWhisperLanguage(language) {
    whisperLanguage =
        String(language || 'en')
            .split('-')[0]
            .toLowerCase() || 'en';
}

function createWavBuffer(pcm16Buffer) {
    const header = Buffer.alloc(44);
    const byteRate = 16000 * 2;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm16Buffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm16Buffer.length, 40);

    return Buffer.concat([header, pcm16Buffer]);
}

/**
 * Поднимает whisper-server (при необходимости скачав бинарник и модель) и ждёт готовности.
 *
 * Повторный вызов с той же моделью — no-op: сервер общий, и перезапускать его при
 * переключении режимов незачем. Параллельные вызовы разделяют один промис.
 */
async function startWhisper({ model = 'base', language = 'en-US', useVad = true, sendToRenderer = () => {}, onProgress = null, signal = null } = {}) {
    setWhisperLanguage(language);
    const effectiveModel = resolveWhisperModelForLanguage(model, whisperLanguage);

    if (isWhisperRunning() && activeModel === effectiveModel && activeVad === useVad) {
        return whisperBaseUrl;
    }
    if (startPromise) {
        return startPromise;
    }
    if (isWhisperRunning()) {
        stopWhisper();
    }

    startPromise = (async () => {
        const progress = label => p => {
            if (onProgress) onProgress(label, p);
        };

        const binaryPath = await ensureNativeBinary('whisper', progress('Whisper runner'), signal);

        sendToRenderer('whisper-downloading', true);
        let modelPath;
        try {
            modelPath = await ensureWhisperModel(effectiveModel, progress('Whisper model'), signal);
        } finally {
            sendToRenderer('whisper-downloading', false);
        }

        const port = await getAvailablePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const args = ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port)];

        if (useVad) {
            // Модель весит меньше мегабайта, поэтому тянем её молча вместе с основной
            const vadModelPath = await ensureVadModel(progress('Speech detector'), signal);
            args.push('--vad', '--vad-model', vadModelPath);
        }

        const child = startNativeServer({ executablePath: binaryPath, arguments: args, name: 'Whisper' });

        await waitForServer(`${baseUrl}/`, child, 120000);

        whisperProcess = child;
        whisperBaseUrl = baseUrl;
        activeModel = effectiveModel;
        activeVad = useVad;
        console.log(`[Whisper] Сервер готов: ${baseUrl}, модель ${effectiveModel}, язык ${whisperLanguage}, VAD ${useVad ? 'вкл' : 'выкл'}`);
        return baseUrl;
    })();

    try {
        return await startPromise;
    } finally {
        startPromise = null;
    }
}

/** Распознаёт PCM 16 кГц (16 бит, моно). Возвращает текст либо пустую строку. */
async function transcribePcm(pcm16kBuffer) {
    if (!whisperBaseUrl) {
        throw new Error('Whisper server is not running');
    }

    const formData = new FormData();
    formData.append('file', new Blob([createWavBuffer(pcm16kBuffer)], { type: 'audio/wav' }), 'speech.wav');
    formData.append('response_format', 'json');
    formData.append('temperature', '0.0');
    formData.append('language', whisperLanguage);

    const response = await fetch(`${whisperBaseUrl}/inference`, { method: 'POST', body: formData });
    if (!response.ok) {
        throw new Error(`Whisper server returned HTTP ${response.status}`);
    }

    const result = await response.json();
    const text = result.text?.trim() || '';
    console.log('[Whisper] Распознано:', text);
    return text;
}

function stopWhisper() {
    if (whisperProcess) {
        stopNativeServer(whisperProcess);
    }
    whisperProcess = null;
    whisperBaseUrl = null;
    activeModel = null;
    activeVad = null;
}

module.exports = {
    startWhisper,
    transcribePcm,
    stopWhisper,
    isWhisperRunning,
    setWhisperLanguage,
    getWhisperLanguage,
    createWavBuffer,
};
