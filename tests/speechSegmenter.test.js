const { test } = require('node:test');
const assert = require('node:assert');

const { createSpeechSegmenter, MIN_SPEECH_RMS, NOISE_MARGIN, MAX_UTTERANCE_FRAMES } = require('../src/utils/speechSegmenter');

const frame = () => Buffer.alloc(4);

function run(rmsList, options = {}) {
    const utterances = [];
    const segmenter = createSpeechSegmenter({ silenceFrames: 8, onUtterance: (audio, stats) => utterances.push(stats), ...options });
    for (const rms of rmsList) segmenter.push(frame(), rms);
    return { utterances, segmenter };
}

const repeat = (value, count) => Array(count).fill(value);

test('в тихой комнате фраза закрывается после паузы', () => {
    const { utterances } = run([...repeat(0.002, 20), ...repeat(0.1, 10), ...repeat(0.002, 8)]);
    assert.strictEqual(utterances.length, 1);
    assert.strictEqual(utterances[0].forced, false);
});

test('в тихой комнате порог прежний — 0.01', () => {
    const { segmenter } = run(repeat(0.002, 50));
    assert.strictEqual(segmenter.threshold(), MIN_SPEECH_RMS);
});

test('на постоянном фоне выше 0.01 пауза всё равно находится', () => {
    const noise = 0.02;
    const { utterances, segmenter } = run([...repeat(noise, 100), ...repeat(0.15, 10), ...repeat(noise, 8)]);
    assert.ok(segmenter.threshold() >= noise * NOISE_MARGIN * 0.9, `порог ${segmenter.threshold()}`);
    assert.strictEqual(utterances.length, 1);
    assert.strictEqual(utterances[0].forced, false);
});

test('провалы между словами не закрывают фразу раньше паузы', () => {
    const speech = [];
    for (let i = 0; i < 10; i++) speech.push(0.12, 0.12, 0.003);
    const { utterances } = run([...repeat(0.002, 20), ...speech, ...repeat(0.002, 6)]);
    assert.strictEqual(utterances.length, 0);
});

test('бесконечная речь режется по лимиту длины', () => {
    const speech = [];
    while (speech.length < MAX_UTTERANCE_FRAMES + 5) speech.push(0.1, 0.1, 0.1, 0.004);
    const { utterances } = run([...repeat(0.002, 10), ...speech]);
    assert.strictEqual(utterances.length, 1);
    assert.strictEqual(utterances[0].forced, true);
    assert.strictEqual(utterances[0].frames, MAX_UTTERANCE_FRAMES);
});

test('ровный громкий звук без провалов уходит в фон, а не копится вечно', () => {
    const { utterances } = run([...repeat(0.002, 10), ...repeat(0.1, MAX_UTTERANCE_FRAMES + 5)]);
    assert.strictEqual(utterances.length, 1);
    assert.ok(utterances[0].frames < MAX_UTTERANCE_FRAMES);
});

test('короткий щелчок не считается репликой', () => {
    const { utterances } = run([...repeat(0.002, 10), 0.2, 0.2, ...repeat(0.002, 10)]);
    assert.strictEqual(utterances.length, 0);
});

test('в реплику попадает немного звука до начала речи', () => {
    const { utterances } = run([...repeat(0.002, 20), ...repeat(0.1, 5), ...repeat(0.002, 8)]);
    // 5 кадров речи + 8 тишины + предзапись из silenceFrames кадров
    assert.strictEqual(utterances[0].frames, 5 + 8 + 8);
});

test('onSpeechStart вызывается один раз на реплику', () => {
    let starts = 0;
    run([...repeat(0.002, 10), ...repeat(0.1, 5), ...repeat(0.002, 8), ...repeat(0.1, 5), ...repeat(0.002, 8)], {
        onSpeechStart: () => starts++,
    });
    assert.strictEqual(starts, 2);
});

test('отброшенный щелчок сообщает onSpeechDiscarded', () => {
    let discarded = 0;
    const { utterances } = run([...repeat(0.002, 10), 0.2, 0.2, ...repeat(0.002, 10)], { onSpeechDiscarded: () => discarded++ });
    assert.strictEqual(utterances.length, 0);
    assert.strictEqual(discarded, 1);
});
