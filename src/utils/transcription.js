// ── Общий аудио-конвейер: ресемплинг, VAD-энергия, распознавание ──
//
// Распознавание выполняет whisper.cpp через ./whisperService (общий whisper-server).
// Раньше здесь жил transformers.js/onnxruntime: на том же аудио он был примерно
// вчетверо медленнее, грузился ~19 секунд вместо ~0.3 и требовал зависимостей
// @huggingface/transformers + onnxruntime-node с распаковкой из ASAR.
//
// Этот модуль НЕ должен требовать ./gemini или ./localai (циклы зависимостей).
// Общение с рендерером — через переданный колбэк sendToRenderer.

const whisper = require('./whisperService');

// Буфер остатка ресемплинга
let resampleRemainder = Buffer.alloc(0);

function setTranscribeLanguage(language) {
    whisper.setWhisperLanguage(language);
}

function resetResampleState() {
    resampleRemainder = Buffer.alloc(0);
}

// ── Ресемплинг 24 кГц → 16 кГц ──

function resample24kTo16k(inputBuffer) {
    // Приклеиваем остаток от предыдущего вызова
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2); // 16 бит = 2 байта на сэмпл
    // Отношение 16000/24000 = 2/3: на каждые 3 входных сэмпла получаем 2 выходных
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        const s0 = combined.readInt16LE(srcIndex * 2);
        const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

// ── VAD (детектор речи) ──

function calculateRMS(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function pcm16ToFloat32(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        float32[i] = pcm16Buffer.readInt16LE(i * 2) / 32768;
    }
    return float32;
}

// ── Распознавание ──

/**
 * Поднимает общий whisper-server. Имя сохранено историческим (раньше грузился
 * transformers.js-пайплайн), чтобы не трогать вызывающий код.
 */
async function loadWhisperPipeline(modelName, sendToRenderer) {
    try {
        sendToRenderer('update-status', 'Starting Whisper...');
        await whisper.startWhisper({
            model: modelName,
            language: whisper.getWhisperLanguage(),
            sendToRenderer,
            onProgress: (label, progress) => {
                if (!progress?.expectedBytes) return;
                const percentage = Math.floor((progress.downloadedBytes / progress.expectedBytes) * 100);
                sendToRenderer('update-status', `Downloading ${label}... ${percentage}%`);
            },
        });
        return true;
    } catch (error) {
        console.error('[Whisper] Не удалось запустить сервер:', error);
        sendToRenderer('whisper-downloading', false);
        sendToRenderer('update-status', 'Failed to start Whisper: ' + error.message);
        return null;
    }
}

async function transcribeAudio(pcm16kBuffer, sendToRenderer) {
    if (!whisper.isWhisperRunning()) {
        console.error('[Whisper] Сервер не запущен');
        return null;
    }

    try {
        return await whisper.transcribePcm(pcm16kBuffer);
    } catch (error) {
        console.error('[Whisper] Ошибка распознавания:', error);
        return null;
    }
}

function isNoiseTranscription(text) {
    const stripped = text.replace(/[[(][^\])]*[\])]/g, '').replace(/[\s.,!?…—-]+/g, '');
    return stripped.length < 2;
}

function resetWhisper() {
    whisper.stopWhisper();
}

module.exports = {
    resample24kTo16k,
    calculateRMS,
    pcm16ToFloat32,
    loadWhisperPipeline,
    transcribeAudio,
    isNoiseTranscription,
    resetWhisper,
    setTranscribeLanguage,
    resetResampleState,
};
