const FRAGMENT_HOLD_MS = 1200;
const MAX_CONTINUATION_WAIT_MS = 25000;

function isCompleteUtterance(text) {
    const trimmed = text.trim().replace(/["»)\]]+$/, '');
    if (/(\.\.\.|…)$/.test(trimmed)) return false;
    return /[.!?]$/.test(trimmed);
}

function createUtteranceMerger({ onReady, holdMs = FRAGMENT_HOLD_MS }) {
    let parts = [];
    let lastSpeechEndedAt = null;
    let timer = null;

    function flush() {
        clearTimeout(timer);
        timer = null;
        const text = parts.join(' ');
        const merged = parts.length;
        parts = [];
        onReady(text, { speechEndedAt: lastSpeechEndedAt, merged });
    }

    function push(text, speechEndedAt) {
        parts.push(text.trim());
        lastSpeechEndedAt = speechEndedAt;
        if (isCompleteUtterance(text)) {
            flush();
            return;
        }
        schedule(holdMs);
    }

    function schedule(ms) {
        clearTimeout(timer);
        timer = setTimeout(flush, ms);
    }

    function speechStarted() {
        if (parts.length > 0) schedule(MAX_CONTINUATION_WAIT_MS);
    }

    // Начавшаяся речь оказалась щелчком или пустой репликой — продолжения не будет
    function speechAbandoned() {
        if (parts.length > 0) schedule(holdMs);
    }

    function reset() {
        clearTimeout(timer);
        timer = null;
        parts = [];
    }

    return { push, speechStarted, speechAbandoned, reset };
}

module.exports = { createUtteranceMerger, isCompleteUtterance, FRAGMENT_HOLD_MS, MAX_CONTINUATION_WAIT_MS };
