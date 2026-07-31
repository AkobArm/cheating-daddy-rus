const { test } = require('node:test');
const assert = require('node:assert');

const { createAudioMixer, mixFrames, FRAME_SAMPLES, SOURCE_IDLE_MS } = require('../src/utils/audioMixer');

/** PCM16-буфер из постоянного значения; length — число сэмплов */
function tone(value, samples) {
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) buffer.writeInt16LE(value, i * 2);
    return buffer;
}

/** Столько сэмплов 24 кГц нужно, чтобы получить n сэмплов 16 кГц */
function samples24kFor(target16k) {
    return Math.ceil((target16k * 3) / 2);
}

test('mixFrames складывает два сигнала', () => {
    const mixed = mixFrames(tone(1000, 4), tone(2000, 4));
    for (let i = 0; i < 4; i++) assert.strictEqual(mixed.readInt16LE(i * 2), 3000);
});

test('mixFrames ограничивает пропорционально, а не обрезает', () => {
    const mixed = mixFrames(tone(30000, 2), tone(20000, 2));
    // сумма 50000 выходит за диапазон — ждём ровно верхнюю границу, без переполнения
    assert.strictEqual(mixed.readInt16LE(0), 32767);
});

test('mixFrames так же ограничивает отрицательные суммы', () => {
    const mixed = mixFrames(tone(-30000, 2), tone(-20000, 2));
    assert.strictEqual(mixed.readInt16LE(0), -32767);
});

test('mixFrames режет по более короткому кадру', () => {
    const mixed = mixFrames(tone(100, 10), tone(100, 4));
    assert.strictEqual(mixed.length / 2, 4);
});

test('микрофон, который не придёт, не блокирует поток дольше таймаута', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { now: () => clock });

    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES)));
    assert.strictEqual(frames.length, 0, 'сразу не отдаём — ждём микрофон');

    clock += SOURCE_IDLE_MS + 100;
    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES)));
    assert.ok(frames.length >= 1, 'после таймаута системный звук идёт без микрофона');
});

test('оба источника сводятся в один кадр', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { now: () => clock });

    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES)));
    assert.strictEqual(frames.length, 0, 'ждём второй источник, пока он не признан молчащим');

    mixer.pushMic(tone(2000, samples24kFor(FRAME_SAMPLES)));
    assert.strictEqual(frames.length, 1);
    assert.strictEqual(frames[0].length / 2, FRAME_SAMPLES);
    assert.strictEqual(frames[0].readInt16LE(0), 3000, 'кадр должен быть суммой источников');
});

test('замолчавший микрофон не задерживает системный звук, но записанное не теряется', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { now: () => clock });

    // микрофон прислал кадр и замолчал
    mixer.pushMic(tone(500, samples24kFor(FRAME_SAMPLES)));
    frames.length = 0;

    clock += SOURCE_IDLE_MS + 100;
    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES * 2)));

    assert.ok(frames.length >= 2, 'системный звук должен пройти, не дожидаясь микрофона');
    // накопленный микрофонный кадр не выбрасываем — сводим с первым системным
    assert.strictEqual(frames[0].readInt16LE(0), 1500, 'первый кадр — сумма с остатком микрофона');
    // дальше микрофонная очередь пуста, идёт чистый системный звук
    assert.strictEqual(frames[1].readInt16LE(0), 1000, 'дальше системный звук без изменений');
});

test('режим только системного звука работает как сквозной', () => {
    const frames = [];
    let clock = 1000;
    // audioMode = speaker_only: микрофона в этой сессии не будет
    const mixer = createAudioMixer(f => frames.push(f), { expectMic: false, now: () => clock });

    // микрофон не подключался ни разу
    mixer.pushSystem(tone(1234, samples24kFor(FRAME_SAMPLES * 3)));
    assert.ok(frames.length >= 3);
    assert.strictEqual(frames[0].readInt16LE(0), 1234);
});

test('у источников независимые ресемплеры', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { now: () => clock });

    // мелкими кусками вперемешку — раньше это ломало общий остаток ресемплера
    for (let i = 0; i < 40; i++) {
        mixer.pushSystem(tone(1000, 120));
        mixer.pushMic(tone(2000, 120));
    }

    assert.ok(frames.length > 0, 'кадры должны появиться');
    for (const frame of frames) {
        for (let i = 0; i < frame.length / 2; i++) {
            // при исправном ресемплинге постоянные сигналы дают ровно сумму
            assert.strictEqual(frame.readInt16LE(i * 2), 3000);
        }
    }
});

test('reset очищает очереди', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { expectMic: false, now: () => clock });

    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES / 2)));
    mixer.reset();
    frames.length = 0;

    clock += SOURCE_IDLE_MS + 100;
    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES / 2)));
    assert.strictEqual(frames.length, 0, 'после reset накопленного не осталось, на полкадра не хватает');
});

test('flush отдаёт хвост, застрявший в ожидании второго источника', () => {
    const frames = [];
    let clock = 1000;
    const mixer = createAudioMixer(f => frames.push(f), { now: () => clock });

    // системного звука больше, чем микрофонного: хвост ждёт микрофон, которого не будет
    mixer.pushSystem(tone(1000, samples24kFor(FRAME_SAMPLES * 3)));
    mixer.pushMic(tone(2000, samples24kFor(FRAME_SAMPLES)));
    const beforeFlush = frames.reduce((sum, f) => sum + f.length / 2, 0);

    mixer.flush();
    const afterFlush = frames.reduce((sum, f) => sum + f.length / 2, 0);

    assert.ok(afterFlush > beforeFlush, 'flush должен выпустить накопленное');
    assert.ok(afterFlush >= FRAME_SAMPLES * 3, `ожидали минимум 3 кадра, получили ${afterFlush / FRAME_SAMPLES}`);
});

test('flush на пустых очередях ничего не отдаёт', () => {
    const frames = [];
    const mixer = createAudioMixer(f => frames.push(f), { now: () => 1000 });
    mixer.flush();
    assert.strictEqual(frames.length, 0);
});
