const MIN_SPEECH_RMS = 0.01;
const NOISE_MARGIN = 2;
const NOISE_RISE_PER_FRAME = 1.02;
const MIN_SPEECH_FRAMES = 3;
const MAX_UTTERANCE_FRAMES = 200; // 20 с

function createSpeechSegmenter({ silenceFrames, onUtterance, onSpeechStart = () => {}, onSpeechDiscarded = () => {} }) {
    let buffer = [];
    let isSpeaking = false;
    let silenceCount = 0;
    let speechFrames = 0;
    let noiseFloor = null;

    const threshold = () => Math.max(MIN_SPEECH_RMS, (noiseFloor ?? 0) * NOISE_MARGIN);

    function updateNoiseFloor(rms) {
        if (noiseFloor === null || rms < noiseFloor) {
            noiseFloor = rms;
        } else {
            noiseFloor = Math.min(rms, noiseFloor * NOISE_RISE_PER_FRAME);
        }
    }

    function reset() {
        buffer = [];
        isSpeaking = false;
        silenceCount = 0;
        speechFrames = 0;
    }

    function emit(forced) {
        const stats = { frames: buffer.length, forced, noiseFloor, threshold: threshold() };
        const audio = Buffer.concat(buffer);
        reset();
        onUtterance(audio, stats);
    }

    function push(pcm16k, rms) {
        const isLoud = rms > threshold();
        updateNoiseFloor(rms);
        buffer.push(pcm16k);

        if (isLoud) {
            if (!isSpeaking) {
                isSpeaking = true;
                onSpeechStart();
            }
            silenceCount = 0;
            speechFrames++;
        } else if (isSpeaking) {
            silenceCount++;
            if (silenceCount >= silenceFrames) {
                if (speechFrames < MIN_SPEECH_FRAMES) {
                    reset();
                    onSpeechDiscarded();
                    return;
                }
                emit(false);
                return;
            }
        } else if (buffer.length > silenceFrames) {
            buffer.shift();
        }

        if (isSpeaking && buffer.length >= MAX_UTTERANCE_FRAMES) {
            emit(true);
        }
    }

    return { push, threshold, noiseFloor: () => noiseFloor };
}

module.exports = {
    createSpeechSegmenter,
    MIN_SPEECH_RMS,
    NOISE_MARGIN,
    MIN_SPEECH_FRAMES,
    MAX_UTTERANCE_FRAMES,
};
