const { test, mock } = require('node:test');
const assert = require('node:assert');

const { createUtteranceMerger, isCompleteUtterance, FRAGMENT_HOLD_MS, MAX_CONTINUATION_WAIT_MS } = require('../src/utils/utteranceMerger');

test('законченной считается фраза с . ? !', () => {
    assert.ok(isCompleteUtterance('Расскажите про Kafka.'));
    assert.ok(isCompleteUtterance('Как устроен индекс?'));
    assert.ok(isCompleteUtterance('Отлично!'));
    assert.ok(isCompleteUtterance('Что такое GIL?»'));
});

test('обрывок — запятая, многоточие или нет знака в конце', () => {
    assert.ok(!isCompleteUtterance('Да, ту задачу, которую я себе взял,'));
    assert.ok(!isCompleteUtterance('и тогда мы...'));
    assert.ok(!isCompleteUtterance('и тогда мы…'));
    assert.ok(!isCompleteUtterance('verification session'));
    assert.ok(!isCompleteUtterance('Объясни мне, что нужно сделать для того, чтобы у меня с\nессию'));
});

function setup() {
    mock.timers.enable({ apis: ['setTimeout'] });
    const ready = [];
    const merger = createUtteranceMerger({ onReady: (text, meta) => ready.push({ text, ...meta }) });
    return { ready, merger, tick: ms => mock.timers.tick(ms), done: () => mock.timers.reset() };
}

test('законченная фраза уходит сразу', () => {
    const { ready, merger, done } = setup();
    try {
        merger.push('Как устроен индекс?', 1000);
        assert.deepStrictEqual(ready, [{ text: 'Как устроен индекс?', speechEndedAt: 1000, merged: 1 }]);
    } finally {
        done();
    }
});

test('обрывок ждёт продолжения и склеивается с ним', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('Да, ту задачу, которую я себе взял,', 1000);
        tick(FRAGMENT_HOLD_MS - 1);
        assert.strictEqual(ready.length, 0);
        merger.push('которые отправляют смс-код или email-код.', 2000);
        assert.deepStrictEqual(ready, [
            { text: 'Да, ту задачу, которую я себе взял, которые отправляют смс-код или email-код.', speechEndedAt: 2000, merged: 2 },
        ]);
        tick(FRAGMENT_HOLD_MS * 2);
        assert.strictEqual(ready.length, 1, 'таймер обрывка не должен выстрелить повторно');
    } finally {
        done();
    }
});

test('обрывок без продолжения уходит по таймауту как есть', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('verification session', 1000);
        tick(FRAGMENT_HOLD_MS);
        assert.deepStrictEqual(ready, [{ text: 'verification session', speechEndedAt: 1000, merged: 1 }]);
    } finally {
        done();
    }
});

test('несколько обрывков подряд копятся, ожидание продлевается', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('Объясни,', 1000);
        tick(FRAGMENT_HOLD_MS - 100);
        merger.push('что нужно сделать,', 2000);
        tick(FRAGMENT_HOLD_MS - 100);
        assert.strictEqual(ready.length, 0);
        tick(100);
        assert.deepStrictEqual(ready, [{ text: 'Объясни, что нужно сделать,', speechEndedAt: 2000, merged: 2 }]);
    } finally {
        done();
    }
});

test('reset выбрасывает недосказанное', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('и тогда мы', 1000);
        merger.reset();
        tick(FRAGMENT_HOLD_MS * 2);
        assert.strictEqual(ready.length, 0);
    } finally {
        done();
    }
});

test('пока собеседник снова говорит, обрывок не уходит — даже дольше таймаута', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('Да, ту задачу, которую я себе взял,', 1000);
        tick(500);
        merger.speechStarted();
        tick(FRAGMENT_HOLD_MS * 4);
        assert.strictEqual(ready.length, 0);
        merger.push('которые отправляют смс-код или email-код.', 6000);
        assert.strictEqual(ready.length, 1);
        assert.strictEqual(ready[0].merged, 2);
    } finally {
        done();
    }
});

test('если начавшаяся речь оказалась пустой, обрывок уходит по обычному таймауту', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('и тогда мы', 1000);
        merger.speechStarted();
        tick(FRAGMENT_HOLD_MS * 4);
        merger.speechAbandoned();
        tick(FRAGMENT_HOLD_MS - 1);
        assert.strictEqual(ready.length, 0);
        tick(1);
        assert.deepStrictEqual(ready, [{ text: 'и тогда мы', speechEndedAt: 1000, merged: 1 }]);
    } finally {
        done();
    }
});

test('страховка: зависшее ожидание продолжения не держит обрывок вечно', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.push('и тогда мы', 1000);
        merger.speechStarted();
        tick(MAX_CONTINUATION_WAIT_MS);
        assert.strictEqual(ready.length, 1);
    } finally {
        done();
    }
});

test('начало речи без отложенного обрывка ничего не делает', () => {
    const { ready, merger, tick, done } = setup();
    try {
        merger.speechStarted();
        merger.speechAbandoned();
        tick(MAX_CONTINUATION_WAIT_MS);
        assert.strictEqual(ready.length, 0);
    } finally {
        done();
    }
});
