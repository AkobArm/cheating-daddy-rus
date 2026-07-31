// ── Сведение микрофона и системного звука в один поток ──
//
// Микрофон и системный звук приходят разными IPC-каналами (send-mic-audio-content и
// send-audio-content) и раньше подавались в один и тот же конвейер по очереди. Из-за
// этого они портили друг другу состояние ресемплера и склеивались в VAD кусками:
// вместо диалога получалась чересполосица, и собеседника было плохо слышно.
//
// Здесь каждый источник ресемплируется отдельно, а затем кадры складываются по времени
// с мягким лимитером — как в mix_window из meetily. Жёсткое обрезание по ±1.0 даёт
// слышимые щелчки, поэтому при переполнении делим на модуль суммы, сохраняя форму волны.

// 100 мс при 16 кГц — тот же размер кадра, которым оперирует VAD
const FRAME_SAMPLES = 1600;
// Если от источника давно нет данных, считаем его молчащим и не ждём его дольше.
// Это прямая задержка распознавания, поэтому держим её близко к длине кадра.
const SOURCE_IDLE_MS = 250;

function createResampler() {
    let remainder = Buffer.alloc(0);

    return {
        /** 24 кГц → 16 кГц, состояние у каждого источника своё */
        resample(inputBuffer) {
            const combined = Buffer.concat([remainder, inputBuffer]);
            const inputSamples = Math.floor(combined.length / 2);
            const outputSamples = Math.floor((inputSamples * 2) / 3);
            const outputBuffer = Buffer.alloc(outputSamples * 2);

            for (let i = 0; i < outputSamples; i++) {
                const sourcePosition = (i * 3) / 2;
                const sourceIndex = Math.floor(sourcePosition);
                const fraction = sourcePosition - sourceIndex;
                const first = combined.readInt16LE(sourceIndex * 2);
                const second = sourceIndex + 1 < inputSamples ? combined.readInt16LE((sourceIndex + 1) * 2) : first;
                const interpolated = Math.round(first + fraction * (second - first));
                outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
            }

            const consumed = Math.ceil((outputSamples * 3) / 2) * 2;
            remainder = consumed < combined.length ? combined.slice(consumed) : Buffer.alloc(0);
            return outputBuffer;
        },
        reset() {
            remainder = Buffer.alloc(0);
        },
    };
}

/**
 * Складывает два кадра PCM16 с пропорциональным лимитером.
 * Кадры должны быть одной длины; недостающее вызывающий добивает тишиной.
 */
function mixFrames(a, b) {
    const samples = Math.floor(Math.min(a.length, b.length) / 2);
    const mixed = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const sum = a.readInt16LE(i * 2) + b.readInt16LE(i * 2);
        const magnitude = Math.abs(sum);
        // Делим на модуль, а не обрезаем: жёсткий клиппинг слышен щелчками
        const limited = magnitude > 32767 ? Math.round((sum / magnitude) * 32767) : sum;
        mixed.writeInt16LE(limited, i * 2);
    }

    return mixed;
}

/**
 * Создаёт микшер двух источников.
 *
 * @param {(pcm16k: Buffer) => void} onFrame вызывается на каждый готовый кадр 16 кГц
 * @param {{expectMic?: boolean, expectSystem?: boolean, now?: () => number}} options
 *   expectMic/expectSystem — участвует ли источник в этой сессии (берётся из audioMode).
 *   Неожидаемый источник считается молчащим сразу, иначе один включённый поток
 *   простаивал бы в ожидании того, который никогда не придёт.
 */
function createAudioMixer(onFrame, options = {}) {
    const { expectMic = true, expectSystem = true, now = () => Date.now() } = options;
    const systemResampler = createResampler();
    const micResampler = createResampler();
    let systemQueue = Buffer.alloc(0);
    let micQueue = Buffer.alloc(0);
    let systemLastAt = 0;
    let micLastAt = 0;
    let startedAt = now();

    const frameBytes = FRAME_SAMPLES * 2;

    /** Источник молчит, если он не ожидается или давно ничего не присылал. */
    function isIdle(expected, lastAt, timestamp) {
        if (!expected) return true;
        // Пока источник не прислал ни одного куска, отсчитываем ожидание от старта сессии
        return timestamp - (lastAt || startedAt) > SOURCE_IDLE_MS;
    }

    function drain() {
        for (;;) {
            const systemReady = systemQueue.length >= frameBytes;
            const micReady = micQueue.length >= frameBytes;
            const timestamp = now();
            const systemIdle = isIdle(expectSystem, systemLastAt, timestamp);
            const micIdle = isIdle(expectMic, micLastAt, timestamp);

            let frame = null;
            if (systemReady && micReady) {
                const a = systemQueue.subarray(0, frameBytes);
                const b = micQueue.subarray(0, frameBytes);
                frame = mixFrames(a, b);
                systemQueue = systemQueue.subarray(frameBytes);
                micQueue = micQueue.subarray(frameBytes);
            } else if (systemReady && micIdle) {
                frame = Buffer.from(systemQueue.subarray(0, frameBytes));
                systemQueue = systemQueue.subarray(frameBytes);
            } else if (micReady && systemIdle) {
                frame = Buffer.from(micQueue.subarray(0, frameBytes));
                micQueue = micQueue.subarray(frameBytes);
            }

            if (!frame) return;
            onFrame(frame);
        }
    }

    return {
        /** Системный звук, PCM16 24 кГц */
        pushSystem(chunk24k) {
            systemLastAt = now();
            systemQueue = Buffer.concat([systemQueue, systemResampler.resample(chunk24k)]);
            drain();
        },
        /** Микрофон, PCM16 24 кГц */
        pushMic(chunk24k) {
            micLastAt = now();
            micQueue = Buffer.concat([micQueue, micResampler.resample(chunk24k)]);
            drain();
        },
        /**
         * Отдаёт всё накопленное, не дожидаясь таймаутов и не добирая до полного кадра.
         * Нужен на остановке потока: иначе хвост записи так и остался бы в очереди.
         */
        flush() {
            for (;;) {
                const systemChunk = systemQueue.length > 0 ? systemQueue.subarray(0, frameBytes) : null;
                const micChunk = micQueue.length > 0 ? micQueue.subarray(0, frameBytes) : null;
                if (!systemChunk && !micChunk) return;

                let frame;
                if (systemChunk && micChunk) {
                    // Кадры могут быть разной длины — короткий добиваем тишиной, чтобы не терять длинный
                    const length = Math.max(systemChunk.length, micChunk.length);
                    const a = Buffer.alloc(length);
                    const b = Buffer.alloc(length);
                    systemChunk.copy(a);
                    micChunk.copy(b);
                    frame = mixFrames(a, b);
                } else {
                    frame = Buffer.from(systemChunk || micChunk);
                }

                systemQueue = systemQueue.subarray(Math.min(frameBytes, systemQueue.length));
                micQueue = micQueue.subarray(Math.min(frameBytes, micQueue.length));
                onFrame(frame);
            }
        },
        reset() {
            systemResampler.reset();
            micResampler.reset();
            systemQueue = Buffer.alloc(0);
            micQueue = Buffer.alloc(0);
            systemLastAt = 0;
            micLastAt = 0;
            startedAt = now();
        },
    };
}

module.exports = {
    createAudioMixer,
    mixFrames,
    FRAME_SAMPLES,
    SOURCE_IDLE_MS,
};
